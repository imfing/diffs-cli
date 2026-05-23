package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/imfing/diffs-cli/internal/appconfig"
	"github.com/imfing/diffs-cli/internal/comments"
	gitcmd "github.com/imfing/diffs-cli/internal/git"
	"github.com/imfing/diffs-cli/internal/webassets"
)

const (
	DefaultGitHubHost = "github.com"
	gitDevNull        = "/dev/null"
)

type Config struct {
	CWD        string
	GitHubHost string
	OnChange   func([]ChangedFile)
	UI         appconfig.UIConfig
	Watch      bool
}

type Server struct {
	cwd        string
	githubHost string
	staticFS   fs.FS
	ui         appconfig.UIConfig
	comments   *comments.Store
	events     *changeBroadcaster
	watcher    *localWatcher
}

type configResponse struct {
	CWD             string `json:"cwd"`
	GitBranch       string `json:"gitBranch"`
	GitHubHost      string `json:"githubHost"`
	ColorScheme     string `json:"colorScheme,omitempty"`
	DiffTheme       string `json:"diffTheme,omitempty"`
	DiffStyle       string `json:"diffStyle,omitempty"`
	WordWrap        *bool  `json:"wordWrap,omitempty"`
	LineNumbers     *bool  `json:"lineNumbers,omitempty"`
	LineBackgrounds *bool  `json:"lineBackgrounds,omitempty"`
}

type gitCommandSpec struct {
	label string
	args  []string
}

func New(cfg Config) (http.Handler, error) {
	cwd := cfg.CWD
	if cwd == "" {
		cwd = "."
	}
	absCWD, err := filepath.Abs(cwd)
	if err != nil {
		return nil, err
	}
	host := strings.TrimSpace(cfg.GitHubHost)
	if host == "" {
		host = DefaultGitHubHost
	}
	ui := appconfig.NormalizeUIConfig(cfg.UI)
	staticFS, err := webassets.DistFS()
	if err != nil {
		return nil, err
	}
	commentStore, commentErr := comments.NewStore(absCWD)
	if cfg.Watch && commentErr != nil {
		return nil, commentErr
	}
	events := newChangeBroadcaster()
	notifyChange := func(paths []string) {
		status, err := gitStatus(absCWD)
		var changed []ChangedFile
		if err == nil {
			changed = changedFilesForEvents(paths, status)
		} else {
			changed = changedFilesFromEvents(paths)
		}
		if len(changed) == 0 {
			return
		}
		events.broadcast()
		if cfg.OnChange != nil {
			cfg.OnChange(changed)
		}
	}
	var watcher *localWatcher
	if cfg.Watch {
		watcher, err = newLocalWatcher(absCWD, notifyChange)
		if err != nil {
			return nil, err
		}
	}
	s := &Server{
		cwd:        absCWD,
		githubHost: host,
		staticFS:   staticFS,
		ui:         ui,
		comments:   commentStore,
		events:     events,
		watcher:    watcher,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/config", s.handleConfig)
	mux.HandleFunc("GET /api/events", s.handleEvents)
	mux.HandleFunc("GET /api/local-diff", s.handleLocalDiff)
	mux.HandleFunc("GET /api/local-comments", s.handleListLocalComments)
	mux.HandleFunc("POST /api/local-comments", s.handleAddLocalComment)
	mux.HandleFunc("POST /api/local-comments/{threadID}/replies", s.handleReplyLocalComment)
	mux.HandleFunc("POST /api/local-comments/{threadID}/resolve", s.handleResolveLocalComment)
	mux.HandleFunc("POST /api/local-comments/{threadID}/reopen", s.handleReopenLocalComment)
	mux.HandleFunc("GET /api/patch/{org}/{repo}/{number}", s.handlePatch)
	mux.HandleFunc("/", s.handleStatic)
	return mux, nil
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	config := configResponse{
		CWD:        s.cwd,
		GitBranch:  s.gitBranch(r.Context()),
		GitHubHost: s.githubHost,
	}
	if appconfig.IsColorScheme(s.ui.ColorScheme) {
		config.ColorScheme = s.ui.ColorScheme
	}
	if appconfig.IsDiffTheme(s.ui.DiffTheme) {
		config.DiffTheme = s.ui.DiffTheme
	}
	if appconfig.IsDiffStyle(s.ui.DiffStyle) {
		config.DiffStyle = s.ui.DiffStyle
	}
	if s.ui.WordWrap != nil {
		config.WordWrap = s.ui.WordWrap
	}
	if s.ui.LineNumbers != nil {
		config.LineNumbers = s.ui.LineNumbers
	}
	if s.ui.LineBackgrounds != nil {
		config.LineBackgrounds = s.ui.LineBackgrounds
	}
	writeJSON(w, http.StatusOK, config)
}

func (s *Server) handleLocalDiff(w http.ResponseWriter, r *http.Request) {
	patch, err := s.localDiff(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(w, patch)
}

func (s *Server) handleListLocalComments(w http.ResponseWriter, r *http.Request) {
	store, ok := s.requireComments(w)
	if !ok {
		return
	}
	threads, err := store.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"threads": threads})
}

func (s *Server) handleAddLocalComment(w http.ResponseWriter, r *http.Request) {
	store, ok := s.requireComments(w)
	if !ok {
		return
	}
	var input comments.AddThreadInput
	if err := readJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	thread, err := store.AddThread(r.Context(), input)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusCreated, thread)
}

func (s *Server) handleReplyLocalComment(w http.ResponseWriter, r *http.Request) {
	store, ok := s.requireComments(w)
	if !ok {
		return
	}
	var input comments.AddReplyInput
	if err := readJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	thread, err := store.AddReply(r.Context(), r.PathValue("threadID"), input)
	writeThreadOrError(w, thread, err)
}

func (s *Server) handleResolveLocalComment(w http.ResponseWriter, r *http.Request) {
	store, ok := s.requireComments(w)
	if !ok {
		return
	}
	thread, err := store.Resolve(r.Context(), r.PathValue("threadID"))
	writeThreadOrError(w, thread, err)
}

func (s *Server) handleReopenLocalComment(w http.ResponseWriter, r *http.Request) {
	store, ok := s.requireComments(w)
	if !ok {
		return
	}
	thread, err := store.Reopen(r.Context(), r.PathValue("threadID"))
	writeThreadOrError(w, thread, err)
}

func (s *Server) requireComments(w http.ResponseWriter) (*comments.Store, bool) {
	if s.comments == nil {
		writeError(w, http.StatusServiceUnavailable, errors.New("local comments require a git repository"))
		return nil, false
	}
	return s.comments, true
}

func writeThreadOrError(w http.ResponseWriter, thread comments.Thread, err error) {
	if errors.Is(err, comments.ErrNotFound) {
		writeError(w, http.StatusNotFound, err)
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, thread)
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, errors.New("streaming is not supported"))
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	events := s.events.subscribe(r.Context())
	_, _ = io.WriteString(w, ": connected\n\n")
	flusher.Flush()

	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-events:
			_, _ = io.WriteString(w, "event: diff\ndata: {}\n\n")
			flusher.Flush()
		case <-ping.C:
			_, _ = io.WriteString(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

func (s *Server) handlePatch(w http.ResponseWriter, r *http.Request) {
	org := r.PathValue("org")
	repo := r.PathValue("repo")
	number := r.PathValue("number")
	if !safePathPart(org) || !safePathPart(repo) || !pullNumber.MatchString(number) {
		writeError(w, http.StatusBadRequest, errors.New("invalid pull request path"))
		return
	}
	patch, err := s.pullRequestPatch(r.Context(), org, repo, number)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(w, patch)
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/" {
		serveIndex(w, r, s.staticFS)
		return
	}

	cleanPath := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if cleanPath == "." {
		serveIndex(w, r, s.staticFS)
		return
	}
	if _, err := fs.Stat(s.staticFS, cleanPath); err == nil {
		http.FileServerFS(s.staticFS).ServeHTTP(w, r)
		return
	}
	serveIndex(w, r, s.staticFS)
}

func (s *Server) localDiff(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	hasHead := s.gitOK(ctx, "rev-parse", "--verify", "HEAD")
	var patch strings.Builder

	commands := []gitCommandSpec{}
	if hasHead {
		commands = append(commands, gitCommandSpec{
			label: "git diff",
			args:  []string{"diff", "--no-ext-diff", "--patch", "--submodule=diff", "HEAD", "--"},
		})
	} else {
		commands = append(commands,
			gitCommandSpec{
				label: "git diff --cached",
				args:  []string{"diff", "--no-ext-diff", "--patch", "--submodule=diff", "--cached", "--"},
			},
			gitCommandSpec{
				label: "git diff",
				args:  []string{"diff", "--no-ext-diff", "--patch", "--submodule=diff", "--"},
			},
		)
	}
	for _, command := range commands {
		out, err := s.gitOutput(ctx, command.label, command.args...)
		if err != nil {
			return "", err
		}
		appendPatch(&patch, out)
	}

	untracked, err := s.untrackedPatch(ctx)
	if err != nil {
		return "", err
	}
	appendPatch(&patch, untracked)

	return patch.String(), nil
}

func (s *Server) pullRequestPatch(ctx context.Context, org, repo, number string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()

	endpoint := fmt.Sprintf("repos/%s/%s/pulls/%s", org, repo, number)
	args := []string{
		"api",
		endpoint,
		"--hostname",
		s.githubHost,
		"-H",
		"Accept: application/vnd.github.v3.patch",
	}
	cmd := exec.CommandContext(ctx, "gh", args...)
	out, err := cmd.Output()
	if err != nil {
		return "", commandError("gh api", err, cmd, "")
	}
	return string(out), nil
}

func (s *Server) untrackedPatch(ctx context.Context) (string, error) {
	raw, err := s.gitOutput(ctx, "git ls-files", "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return "", err
	}

	var patch strings.Builder
	for _, name := range strings.Split(raw, "\x00") {
		if name == "" {
			continue
		}
		out, err := s.gitDiffNoIndex(ctx, name)
		if err != nil {
			return "", err
		}
		appendPatch(&patch, out)
	}
	return patch.String(), nil
}

func (s *Server) gitDiffNoIndex(ctx context.Context, name string) (string, error) {
	cmd := s.gitCommand(ctx, "diff", "--no-ext-diff", "--patch", "--no-index", "--", gitDevNull, name)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		return stdout.String(), nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return stdout.String(), nil
	}
	return "", commandError("git diff --no-index", err, cmd, stderr.String())
}

func (s *Server) gitOK(ctx context.Context, args ...string) bool {
	return gitcmd.OK(ctx, s.cwd, args...)
}

func (s *Server) gitBranch(ctx context.Context) string {
	ctx, cancel := context.WithTimeout(ctx, gitcmd.DefaultTimeout)
	defer cancel()
	return gitcmd.Branch(ctx, s.cwd)
}

func (s *Server) gitOutput(ctx context.Context, label string, args ...string) (string, error) {
	cmd := s.gitCommand(ctx, args...)
	out, err := cmd.Output()
	if err != nil {
		return "", commandError(label, err, cmd, "")
	}
	return string(out), nil
}

func (s *Server) gitCommand(ctx context.Context, args ...string) *exec.Cmd {
	return gitcmd.Command(ctx, s.cwd, args...)
}

func appendPatch(b *strings.Builder, patch string) {
	if patch == "" {
		return
	}
	b.WriteString(patch)
	if !strings.HasSuffix(patch, "\n") {
		b.WriteByte('\n')
	}
}

func commandError(label string, err error, cmd *exec.Cmd, stderr string) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%s timed out", label)
	}
	if stderr = strings.TrimSpace(stderr); stderr != "" {
		return fmt.Errorf("%s failed: %s", label, stderr)
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		stderr := strings.TrimSpace(string(exitErr.Stderr))
		if stderr != "" {
			return fmt.Errorf("%s failed: %s", label, stderr)
		}
	}
	if cmd != nil && cmd.Err != nil {
		return fmt.Errorf("%s failed: %w", label, cmd.Err)
	}
	return fmt.Errorf("%s failed: %w", label, err)
}

func serveIndex(w http.ResponseWriter, r *http.Request, staticFS fs.FS) {
	data, err := fs.ReadFile(staticFS, "index.html")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(data))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func readJSON(r *http.Request, v any) error {
	defer func() { _ = r.Body.Close() }()
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	return nil
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

var pullNumber = regexp.MustCompile(`^[1-9][0-9]*$`)
var safePathPartPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func safePathPart(s string) bool {
	if s == "" || strings.HasPrefix(s, "-") || strings.Contains(s, "..") || strings.ContainsAny(s, `/\`) {
		return false
	}
	return safePathPartPattern.MatchString(s)
}
