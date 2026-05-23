package comments

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	DefaultAuthor = "local"
	DefaultSide   = "additions"
)

var ErrNotFound = errors.New("comment thread not found")

type Store struct {
	root string
	path string
	now  func() time.Time
}

type File struct {
	Version int      `json:"version"`
	Repo    string   `json:"repo"`
	Threads []Thread `json:"threads"`
}

type Thread struct {
	ID        string    `json:"id"`
	Provider  string    `json:"provider"`
	Branch    string    `json:"branch"`
	Path      string    `json:"path"`
	Side      string    `json:"side"`
	Line      int       `json:"line"`
	EndSide   string    `json:"endSide,omitempty"`
	EndLine   int       `json:"endLine,omitempty"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Comments  []Comment `json:"comments"`
}

type Comment struct {
	ID        string    `json:"id"`
	Author    string    `json:"author"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"createdAt"`
}

type AddThreadInput struct {
	Path    string `json:"path"`
	Side    string `json:"side"`
	Line    int    `json:"line"`
	EndSide string `json:"endSide"`
	EndLine int    `json:"endLine"`
	Body    string `json:"body"`
	Author  string `json:"author"`
}

type AddReplyInput struct {
	Body   string `json:"body"`
	Author string `json:"author"`
}

func NewStore(cwd string) (*Store, error) {
	root, err := gitRoot(context.Background(), cwd)
	if err != nil {
		return nil, err
	}
	return &Store{
		root: root,
		path: filepath.Join(root, ".diffs", "comments.json"),
		now:  time.Now,
	}, nil
}

func (s *Store) Path() string {
	return s.path
}

func (s *Store) Root() string {
	return s.root
}

func (s *Store) Branch(ctx context.Context) string {
	branch, err := gitOutput(ctx, s.root, "branch", "--show-current")
	if err == nil && strings.TrimSpace(branch) != "" {
		return strings.TrimSpace(branch)
	}
	commit, err := gitOutput(ctx, s.root, "rev-parse", "--short", "HEAD")
	if err == nil && strings.TrimSpace(commit) != "" {
		return strings.TrimSpace(commit)
	}
	return "local"
}

func (s *Store) List(ctx context.Context) ([]Thread, error) {
	file, err := s.load()
	if err != nil {
		return nil, err
	}
	branch := s.Branch(ctx)
	threads := make([]Thread, 0, len(file.Threads))
	for _, thread := range file.Threads {
		if thread.Branch == branch {
			threads = append(threads, thread)
		}
	}
	return threads, nil
}

func (s *Store) AddThread(ctx context.Context, input AddThreadInput) (Thread, error) {
	path, side, line, endSide, endLine, body, err := cleanThreadInput(input.Path, input.Side, input.Line, input.EndSide, input.EndLine, input.Body)
	if err != nil {
		return Thread{}, err
	}
	author := cleanAuthor(input.Author)
	now := s.now().UTC()
	thread := Thread{
		ID:        newID("thr"),
		Provider:  "local",
		Branch:    s.Branch(ctx),
		Path:      path,
		Side:      side,
		Line:      line,
		Status:    "open",
		CreatedAt: now,
		UpdatedAt: now,
		Comments: []Comment{{
			ID:        newID("cmt"),
			Author:    author,
			Body:      body,
			CreatedAt: now,
		}},
	}
	if endLine != line || endSide != side {
		thread.EndSide = endSide
		thread.EndLine = endLine
	}

	file, err := s.load()
	if err != nil {
		return Thread{}, err
	}
	file.Threads = append(file.Threads, thread)
	if err := s.save(file); err != nil {
		return Thread{}, err
	}
	return thread, nil
}

func (s *Store) AddReply(ctx context.Context, threadID string, input AddReplyInput) (Thread, error) {
	body := strings.TrimSpace(input.Body)
	if body == "" {
		return Thread{}, errors.New("body is required")
	}
	return s.updateThread(ctx, threadID, func(thread *Thread, now time.Time) error {
		thread.Comments = append(thread.Comments, Comment{
			ID:        newID("cmt"),
			Author:    cleanAuthor(input.Author),
			Body:      body,
			CreatedAt: now,
		})
		thread.UpdatedAt = now
		return nil
	})
}

func (s *Store) Resolve(ctx context.Context, threadID string) (Thread, error) {
	return s.setStatus(ctx, threadID, "resolved")
}

func (s *Store) Reopen(ctx context.Context, threadID string) (Thread, error) {
	return s.setStatus(ctx, threadID, "open")
}

func (s *Store) setStatus(ctx context.Context, threadID, status string) (Thread, error) {
	return s.updateThread(ctx, threadID, func(thread *Thread, now time.Time) error {
		thread.Status = status
		thread.UpdatedAt = now
		return nil
	})
}

func (s *Store) updateThread(ctx context.Context, threadID string, update func(*Thread, time.Time) error) (Thread, error) {
	threadID = strings.TrimSpace(threadID)
	if threadID == "" {
		return Thread{}, errors.New("thread id is required")
	}
	file, err := s.load()
	if err != nil {
		return Thread{}, err
	}
	branch := s.Branch(ctx)
	for i := range file.Threads {
		if file.Threads[i].ID != threadID || file.Threads[i].Branch != branch {
			continue
		}
		now := s.now().UTC()
		if err := update(&file.Threads[i], now); err != nil {
			return Thread{}, err
		}
		thread := file.Threads[i]
		if err := s.save(file); err != nil {
			return Thread{}, err
		}
		return thread, nil
	}
	return Thread{}, ErrNotFound
}

func (s *Store) load() (File, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return File{Version: 1, Repo: s.root, Threads: []Thread{}}, nil
	}
	if err != nil {
		return File{}, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return File{Version: 1, Repo: s.root, Threads: []Thread{}}, nil
	}
	var file File
	if err := json.Unmarshal(data, &file); err != nil {
		return File{}, err
	}
	if file.Version == 0 {
		file.Version = 1
	}
	if file.Repo == "" {
		file.Repo = s.root
	}
	if file.Threads == nil {
		file.Threads = []Thread{}
	}
	return file, nil
}

func (s *Store) save(file File) error {
	file.Version = 1
	file.Repo = s.root
	if file.Threads == nil {
		file.Threads = []Thread{}
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	tmp, err := os.CreateTemp(dir, ".comments-*.json")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, s.path)
}

func cleanThreadInput(path, side string, line int, endSide string, endLine int, body string) (string, string, int, string, int, string, error) {
	path = filepath.ToSlash(strings.TrimSpace(path))
	side = strings.TrimSpace(side)
	endSide = strings.TrimSpace(endSide)
	body = strings.TrimSpace(body)
	if path == "" {
		return "", "", 0, "", 0, "", errors.New("path is required")
	}
	if strings.HasPrefix(path, "../") || path == ".." || filepath.IsAbs(path) {
		return "", "", 0, "", 0, "", errors.New("path must be relative to the repository")
	}
	if line < 1 {
		return "", "", 0, "", 0, "", errors.New("line must be greater than zero")
	}
	if endLine == 0 {
		endLine = line
	}
	if endLine < 1 {
		return "", "", 0, "", 0, "", errors.New("end line must be greater than zero")
	}
	if side == "" {
		side = DefaultSide
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
	return path, side, line, endSide, endLine, body, nil
}

func cleanAuthor(author string) string {
	author = strings.TrimSpace(author)
	if author == "" {
		return DefaultAuthor
	}
	return author
}

func gitRoot(ctx context.Context, cwd string) (string, error) {
	if cwd == "" {
		cwd = "."
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return "", err
	}
	root, err := gitOutput(ctx, abs, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", fmt.Errorf("not a git repository: %w", err)
	}
	return strings.TrimSpace(root), nil
}

func gitOutput(ctx context.Context, cwd string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func newID(prefix string) string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	}
	return prefix + "_" + hex.EncodeToString(b[:])
}
