package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/imfing/diffs-cli/internal/comments"
)

const githubCommentsTimeout = 30 * time.Second

var runGH = defaultRunGH

type githubReviewThreadsResponse struct {
	Data struct {
		Repository struct {
			PullRequest struct {
				ReviewThreads struct {
					Nodes    []githubReviewThread `json:"nodes"`
					PageInfo struct {
						HasNextPage bool   `json:"hasNextPage"`
						EndCursor   string `json:"endCursor"`
					} `json:"pageInfo"`
				} `json:"reviewThreads"`
			} `json:"pullRequest"`
		} `json:"repository"`
	} `json:"data"`
}

type githubReviewThread struct {
	ID            string `json:"id"`
	IsResolved    bool   `json:"isResolved"`
	Path          string `json:"path"`
	Line          int    `json:"line"`
	DiffSide      string `json:"diffSide"`
	StartLine     int    `json:"startLine"`
	StartDiffSide string `json:"startDiffSide"`
	Comments      struct {
		Nodes []githubReviewComment `json:"nodes"`
	} `json:"comments"`
}

type githubReviewComment struct {
	ID         string    `json:"id"`
	DatabaseID int64     `json:"databaseId"`
	Author     *ghAuthor `json:"author"`
	Body       string    `json:"body"`
	URL        string    `json:"url"`
	CreatedAt  time.Time `json:"createdAt"`
}

type ghAuthor struct {
	Login string `json:"login"`
}

type githubPullResponse struct {
	Title     string    `json:"title"`
	State     string    `json:"state"`
	Draft     bool      `json:"draft"`
	Merged    bool      `json:"merged"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Additions int       `json:"additions"`
	Deletions int       `json:"deletions"`
	Changed   int       `json:"changed_files"`
	Commits   int       `json:"commits"`
	User      *ghAuthor `json:"user"`
	Head      struct {
		SHA   string `json:"sha"`
		Ref   string `json:"ref"`
		Label string `json:"label"`
		Repo  struct {
			FullName string `json:"full_name"`
		} `json:"repo"`
	} `json:"head"`
	Base struct {
		Ref   string `json:"ref"`
		Label string `json:"label"`
		Repo  struct {
			FullName string `json:"full_name"`
		} `json:"repo"`
	} `json:"base"`
}

type pullRequestInfoResponse struct {
	Title        string    `json:"title"`
	State        string    `json:"state"`
	Draft        bool      `json:"draft"`
	Merged       bool      `json:"merged"`
	Author       string    `json:"author"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
	Additions    int       `json:"additions"`
	Deletions    int       `json:"deletions"`
	ChangedFiles int       `json:"changedFiles"`
	Commits      int       `json:"commits"`
	HeadRef      string    `json:"headRef"`
	HeadLabel    string    `json:"headLabel"`
	HeadRepo     string    `json:"headRepo"`
	BaseRef      string    `json:"baseRef"`
	BaseLabel    string    `json:"baseLabel"`
	BaseRepo     string    `json:"baseRepo"`
}

type githubCreatedComment struct {
	ID     int64  `json:"id"`
	NodeID string `json:"node_id"`
}

func (s *Server) listPullRequestComments(ctx context.Context, org, repo, number string) ([]comments.Thread, error) {
	ctx, cancel := context.WithTimeout(ctx, githubCommentsTimeout)
	defer cancel()

	var threads []comments.Thread
	cursor := ""
	for {
		args := []string{
			"api",
			"graphql",
			"--hostname",
			s.githubHost,
			"-f",
			"query=" + reviewThreadsQuery,
			"-F",
			"owner=" + org,
			"-F",
			"name=" + repo,
			"-F",
			"number=" + number,
		}
		if cursor != "" {
			args = append(args, "-F", "cursor="+cursor)
		}
		out, err := s.ghOutput(ctx, "gh api graphql", args...)
		if err != nil {
			return nil, err
		}
		var response githubReviewThreadsResponse
		if err := json.Unmarshal([]byte(out), &response); err != nil {
			return nil, err
		}
		page := response.Data.Repository.PullRequest.ReviewThreads
		for _, thread := range page.Nodes {
			if converted, ok := convertGitHubThread(thread); ok {
				threads = append(threads, converted)
			}
		}
		if !page.PageInfo.HasNextPage {
			return threads, nil
		}
		cursor = page.PageInfo.EndCursor
		if cursor == "" {
			return threads, nil
		}
	}
}

func (s *Server) addPullRequestComment(ctx context.Context, org, repo, number string, input comments.AddThreadInput) (comments.Thread, error) {
	path, side, line, endSide, endLine, body, err := cleanRemoteThreadInput(input)
	if err != nil {
		return comments.Thread{}, err
	}
	sha, err := s.pullRequestHeadSHA(ctx, org, repo, number)
	if err != nil {
		return comments.Thread{}, err
	}

	args := []string{
		"api",
		"-X",
		"POST",
		fmt.Sprintf("repos/%s/%s/pulls/%s/comments", org, repo, number),
		"--hostname",
		s.githubHost,
		"--raw-field",
		"body=" + body,
		"--raw-field",
		"commit_id=" + sha,
		"--raw-field",
		"path=" + path,
		"--raw-field",
		"side=" + githubSide(endSide),
		"--field",
		"line=" + strconv.Itoa(endLine),
	}
	if endLine != line || endSide != side {
		args = append(args,
			"--field",
			"start_line="+strconv.Itoa(line),
			"--raw-field",
			"start_side="+githubSide(side),
		)
	}
	out, err := s.ghOutput(ctx, "gh api create pull request comment", args...)
	if err != nil {
		return comments.Thread{}, err
	}
	var created githubCreatedComment
	if err := json.Unmarshal([]byte(out), &created); err != nil {
		return comments.Thread{}, err
	}
	return s.findPullRequestThread(ctx, org, repo, number, func(thread comments.Thread) bool {
		for _, comment := range thread.Comments {
			if comment.ID == created.NodeID || comment.ID == strconv.FormatInt(created.ID, 10) {
				return true
			}
		}
		return false
	})
}

func (s *Server) addPullRequestReply(ctx context.Context, org, repo, number, threadID string, input comments.AddReplyInput) (comments.Thread, error) {
	body := strings.TrimSpace(input.Body)
	if body == "" {
		return comments.Thread{}, errors.New("body is required")
	}
	thread, err := s.findPullRequestThread(ctx, org, repo, number, func(thread comments.Thread) bool {
		return thread.ID == threadID
	})
	if err != nil {
		return comments.Thread{}, err
	}
	if thread.ReplyToID == 0 {
		return comments.Thread{}, errors.New("pull request thread has no reply target")
	}
	_, err = s.ghOutput(ctx, "gh api create pull request comment reply",
		"api",
		"-X",
		"POST",
		fmt.Sprintf("repos/%s/%s/pulls/%s/comments/%d/replies", org, repo, number, thread.ReplyToID),
		"--hostname",
		s.githubHost,
		"--raw-field",
		"body="+body,
	)
	if err != nil {
		return comments.Thread{}, err
	}
	return s.findPullRequestThread(ctx, org, repo, number, func(next comments.Thread) bool {
		return next.ID == threadID
	})
}

func (s *Server) setPullRequestThreadResolved(ctx context.Context, org, repo, number, threadID string, resolved bool) (comments.Thread, error) {
	mutation := resolveReviewThreadMutation
	label := "gh api resolve review thread"
	if !resolved {
		mutation = unresolveReviewThreadMutation
		label = "gh api unresolve review thread"
	}
	_, err := s.ghOutput(ctx, label,
		"api",
		"graphql",
		"--hostname",
		s.githubHost,
		"-f",
		"query="+mutation,
		"-F",
		"threadID="+threadID,
	)
	if err != nil {
		return comments.Thread{}, err
	}
	return s.findPullRequestThread(ctx, org, repo, number, func(thread comments.Thread) bool {
		return thread.ID == threadID
	})
}

func (s *Server) findPullRequestThread(ctx context.Context, org, repo, number string, match func(comments.Thread) bool) (comments.Thread, error) {
	threads, err := s.listPullRequestComments(ctx, org, repo, number)
	if err != nil {
		return comments.Thread{}, err
	}
	for _, thread := range threads {
		if match(thread) {
			return thread, nil
		}
	}
	return comments.Thread{}, comments.ErrNotFound
}

func (s *Server) pullRequestHeadSHA(ctx context.Context, org, repo, number string) (string, error) {
	response, err := s.pullRequest(ctx, org, repo, number)
	if err != nil {
		return "", err
	}
	if response.Head.SHA == "" {
		return "", errors.New("pull request head sha is missing")
	}
	return response.Head.SHA, nil
}

func (s *Server) pullRequestInfo(ctx context.Context, org, repo, number string) (pullRequestInfoResponse, error) {
	response, err := s.pullRequest(ctx, org, repo, number)
	if err != nil {
		return pullRequestInfoResponse{}, err
	}
	return pullRequestInfoResponse{
		Title:        response.Title,
		State:        response.State,
		Draft:        response.Draft,
		Merged:       response.Merged,
		Author:       commentAuthor(githubReviewComment{Author: response.User}),
		CreatedAt:    response.CreatedAt,
		UpdatedAt:    response.UpdatedAt,
		Additions:    response.Additions,
		Deletions:    response.Deletions,
		ChangedFiles: response.Changed,
		Commits:      response.Commits,
		HeadRef:      response.Head.Ref,
		HeadLabel:    response.Head.Label,
		HeadRepo:     response.Head.Repo.FullName,
		BaseRef:      response.Base.Ref,
		BaseLabel:    response.Base.Label,
		BaseRepo:     response.Base.Repo.FullName,
	}, nil
}

func (s *Server) pullRequest(ctx context.Context, org, repo, number string) (githubPullResponse, error) {
	out, err := s.ghOutput(ctx, "gh api pull request",
		"api",
		fmt.Sprintf("repos/%s/%s/pulls/%s", org, repo, number),
		"--hostname",
		s.githubHost,
	)
	if err != nil {
		return githubPullResponse{}, err
	}
	var response githubPullResponse
	if err := json.Unmarshal([]byte(out), &response); err != nil {
		return githubPullResponse{}, err
	}
	return response, nil
}

func convertGitHubThread(thread githubReviewThread) (comments.Thread, bool) {
	if thread.ID == "" || len(thread.Comments.Nodes) == 0 {
		return comments.Thread{}, false
	}
	first := thread.Comments.Nodes[0]
	last := thread.Comments.Nodes[len(thread.Comments.Nodes)-1]
	path := thread.Path
	line := thread.Line
	if thread.StartLine > 0 {
		line = thread.StartLine
	}
	if path == "" || line < 1 {
		return comments.Thread{}, false
	}
	side := commentSide(thread.StartDiffSide)
	if side == "" {
		side = commentSide(thread.DiffSide)
	}
	if side == "" {
		side = comments.DefaultSide
	}
	endLine := thread.Line
	if endLine == 0 {
		endLine = line
	}
	endSide := commentSide(thread.DiffSide)
	if endSide == "" {
		endSide = side
	}

	status := "open"
	if thread.IsResolved {
		status = "resolved"
	}
	converted := comments.Thread{
		ID:        thread.ID,
		Provider:  "github",
		Path:      path,
		Side:      side,
		Line:      line,
		Status:    status,
		CreatedAt: first.CreatedAt,
		UpdatedAt: last.CreatedAt,
		ReplyToID: first.DatabaseID,
		URL:       first.URL,
		Comments:  make([]comments.Comment, 0, len(thread.Comments.Nodes)),
	}
	if endLine != line || endSide != side {
		converted.EndLine = endLine
		converted.EndSide = endSide
	}
	for _, comment := range thread.Comments.Nodes {
		converted.Comments = append(converted.Comments, comments.Comment{
			ID:        commentID(comment),
			Author:    commentAuthor(comment),
			Body:      comment.Body,
			CreatedAt: comment.CreatedAt,
		})
	}
	return converted, true
}

func cleanRemoteThreadInput(input comments.AddThreadInput) (string, string, int, string, int, string, error) {
	path := strings.ReplaceAll(strings.TrimSpace(input.Path), "\\", "/")
	side := strings.TrimSpace(input.Side)
	endSide := strings.TrimSpace(input.EndSide)
	body := strings.TrimSpace(input.Body)
	if path == "" {
		return "", "", 0, "", 0, "", errors.New("path is required")
	}
	if line := strings.Trim(path, "/"); line != path || strings.Contains(path, "..") {
		return "", "", 0, "", 0, "", errors.New("path must be relative to the repository")
	}
	if input.Line < 1 {
		return "", "", 0, "", 0, "", errors.New("line must be greater than zero")
	}
	endLine := input.EndLine
	if endLine == 0 {
		endLine = input.Line
	}
	if endLine < input.Line {
		return "", "", 0, "", 0, "", errors.New("end line must be greater than or equal to line")
	}
	if side == "" {
		side = comments.DefaultSide
	}
	if endSide == "" {
		endSide = side
	}
	if side != "additions" && side != "deletions" {
		return "", "", 0, "", 0, "", errors.New("side must be additions or deletions")
	}
	if endSide != "additions" && endSide != "deletions" {
		return "", "", 0, "", 0, "", errors.New("end side must be additions or deletions")
	}
	if body == "" {
		return "", "", 0, "", 0, "", errors.New("body is required")
	}
	return path, side, input.Line, endSide, endLine, body, nil
}

func commentID(comment githubReviewComment) string {
	if comment.ID != "" {
		return comment.ID
	}
	if comment.DatabaseID != 0 {
		return strconv.FormatInt(comment.DatabaseID, 10)
	}
	return ""
}

func commentAuthor(comment githubReviewComment) string {
	if comment.Author != nil && comment.Author.Login != "" {
		return comment.Author.Login
	}
	return "github"
}

func commentSide(side string) string {
	switch side {
	case "RIGHT":
		return "additions"
	case "LEFT":
		return "deletions"
	default:
		return ""
	}
}

func githubSide(side string) string {
	if side == "deletions" {
		return "LEFT"
	}
	return "RIGHT"
}

func defaultRunGH(ctx context.Context, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, "gh", args...).Output()
}

func (s *Server) ghOutput(ctx context.Context, label string, args ...string) (string, error) {
	out, err := runGH(ctx, args...)
	if err != nil {
		return "", commandError(label, err, nil, "")
	}
	return string(out), nil
}

const reviewThreadsQuery = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          path
          line
          diffSide
          startLine
          startDiffSide
          comments(first: 100) {
            nodes {
              id
              databaseId
              author {
                login
              }
              body
              url
              createdAt
            }
          }
        }
      }
    }
  }
}`

const resolveReviewThreadMutation = `
mutation($threadID: ID!) {
  resolveReviewThread(input: {threadId: $threadID}) {
    thread {
      id
      isResolved
    }
  }
}`

const unresolveReviewThreadMutation = `
mutation($threadID: ID!) {
  unresolveReviewThread(input: {threadId: $threadID}) {
    thread {
      id
      isResolved
    }
  }
}`
