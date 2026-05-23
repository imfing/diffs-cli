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
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/imfing/diffs-cli/internal/webassets"
)

type Config struct {
	CWD         string
	ColorScheme string
	GitHubHost  string
	OnChange    func([]string)
}

type Server struct {
	colorScheme string
	cwd         string
	githubHost  string
	staticFS    fs.FS
	events      *changeBroadcaster
	watcher     *localWatcher
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
		host = "github.com"
	}
	staticFS, err := webassets.DistFS()
	if err != nil {
		return nil, err
	}
	events := newChangeBroadcaster()
	notifyChange := func([]string) {
		events.broadcast()
	}
	if cfg.OnChange != nil {
		notifyChange = func(paths []string) {
			events.broadcast()
			cfg.OnChange(paths)
		}
	}
	watcher, _ := newLocalWatcher(absCWD, notifyChange)
	s := &Server{
		colorScheme: strings.TrimSpace(cfg.ColorScheme),
		cwd:         absCWD,
		githubHost:  host,
		staticFS:    staticFS,
		events:      events,
		watcher:     watcher,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/config", s.handleConfig)
	mux.HandleFunc("GET /api/events", s.handleEvents)
	mux.HandleFunc("GET /api/local-diff", s.handleLocalDiff)
	mux.HandleFunc("GET /api/patch/{org}/{repo}/{number}", s.handlePatch)
	mux.HandleFunc("/", s.handleStatic)
	return mux, nil
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	config := map[string]string{
		"cwd":        s.cwd,
		"gitBranch":  s.gitBranch(r.Context()),
		"githubHost": s.githubHost,
	}
	if isColorScheme(s.colorScheme) {
		config["colorScheme"] = s.colorScheme
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
	if f, err := s.staticFS.Open(cleanPath); err == nil {
		_ = f.Close()
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

	if hasHead {
		out, err := s.gitOutput(ctx, "git diff", "diff", "--no-ext-diff", "--patch", "--submodule=diff", "HEAD", "--")
		if err != nil {
			return "", err
		}
		appendPatch(&patch, out)
	} else {
		cached, err := s.gitOutput(ctx, "git diff --cached", "diff", "--no-ext-diff", "--patch", "--submodule=diff", "--cached", "--")
		if err != nil {
			return "", err
		}
		appendPatch(&patch, cached)

		unstaged, err := s.gitOutput(ctx, "git diff", "diff", "--no-ext-diff", "--patch", "--submodule=diff", "--")
		if err != nil {
			return "", err
		}
		appendPatch(&patch, unstaged)
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
		return "", commandError("gh api", err, cmd)
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
	cmd := s.gitCommand(ctx, "diff", "--no-ext-diff", "--patch", "--no-index", "--", "/dev/null", name)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return string(out), nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return string(out), nil
	}
	return "", commandError("git diff --no-index", err, cmd)
}

func (s *Server) gitOK(ctx context.Context, args ...string) bool {
	cmd := s.gitCommand(ctx, args...)
	return cmd.Run() == nil
}

func (s *Server) gitBranch(ctx context.Context) string {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	branch, err := s.gitOutput(ctx, "git branch --show-current", "branch", "--show-current")
	if err == nil && strings.TrimSpace(branch) != "" {
		return strings.TrimSpace(branch)
	}

	commit, err := s.gitOutput(ctx, "git rev-parse --short HEAD", "rev-parse", "--short", "HEAD")
	if err == nil {
		return strings.TrimSpace(commit)
	}
	return ""
}

func (s *Server) gitOutput(ctx context.Context, label string, args ...string) (string, error) {
	cmd := s.gitCommand(ctx, args...)
	out, err := cmd.Output()
	if err != nil {
		return "", commandError(label, err, cmd)
	}
	return string(out), nil
}

func (s *Server) gitCommand(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = s.cwd
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	return cmd
}

func appendPatch(b *strings.Builder, patch string) {
	if patch == "" {
		return
	}
	if b.Len() > 0 && !strings.HasSuffix(b.String(), "\n") {
		b.WriteByte('\n')
	}
	b.WriteString(patch)
	if !strings.HasSuffix(patch, "\n") {
		b.WriteByte('\n')
	}
}

func commandError(label string, err error, cmd *exec.Cmd) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%s timed out", label)
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

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

var pullNumber = regexp.MustCompile(`^[1-9][0-9]*$`)

func safePathPart(s string) bool {
	if s == "" || strings.Contains(s, "..") || strings.ContainsAny(s, `/\`) {
		return false
	}
	return true
}

func isColorScheme(s string) bool {
	return s == "dark" || s == "light" || s == "system"
}
