package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

func TestConfigIncludesCurrentBranch(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init")
	git(t, dir, "checkout", "-b", "feature/local-title")

	handler, err := New(Config{CWD: dir})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var got struct {
		GitBranch string `json:"gitBranch"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.GitBranch != "feature/local-title" {
		t.Fatalf("gitBranch = %q, want feature/local-title", got.GitBranch)
	}
}

func TestConfigIncludesColorSchemeWhenConfigured(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init")

	handler, err := New(Config{CWD: dir, ColorScheme: "dark"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var got struct {
		ColorScheme string `json:"colorScheme"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.ColorScheme != "dark" {
		t.Fatalf("colorScheme = %q, want dark", got.ColorScheme)
	}
}

func TestLocalDiffIncludesUntrackedFilesInUnbornRepo(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init")
	writeFile(t, filepath.Join(dir, "new.txt"), "hello\n")

	patch, err := (&Server{cwd: dir}).localDiff(context.Background())
	if err != nil {
		t.Fatalf("localDiff() error = %v", err)
	}
	for _, want := range []string{
		"diff --git a/new.txt b/new.txt",
		"new file mode",
		"--- /dev/null",
		"+++ b/new.txt",
		"+hello",
	} {
		if !strings.Contains(patch, want) {
			t.Fatalf("localDiff() missing %q in patch:\n%s", want, patch)
		}
	}
}

func TestLocalDiffIncludesStagedAndUnstagedTrackedChanges(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init")
	git(t, dir, "config", "user.email", "test@example.com")
	git(t, dir, "config", "user.name", "Test")
	writeFile(t, filepath.Join(dir, "tracked.txt"), "one\n")
	git(t, dir, "add", "tracked.txt")
	git(t, dir, "commit", "-m", "init")
	writeFile(t, filepath.Join(dir, "tracked.txt"), "one\ntwo\n")
	git(t, dir, "add", "tracked.txt")
	writeFile(t, filepath.Join(dir, "tracked.txt"), "one\ntwo\nthree\n")

	patch, err := (&Server{cwd: dir}).localDiff(context.Background())
	if err != nil {
		t.Fatalf("localDiff() error = %v", err)
	}
	for _, want := range []string{"+two", "+three"} {
		if !strings.Contains(patch, want) {
			t.Fatalf("localDiff() missing %q in patch:\n%s", want, patch)
		}
	}
}

func TestEventsStreamOnLocalFileChange(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init")
	git(t, dir, "config", "user.email", "test@example.com")
	git(t, dir, "config", "user.name", "Test")
	writeFile(t, filepath.Join(dir, "tracked.txt"), "one\n")
	git(t, dir, "add", "tracked.txt")
	git(t, dir, "commit", "-m", "init")

	handler, err := New(Config{CWD: dir})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	ts := httptest.NewServer(handler)
	defer ts.Close()

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream", got)
	}

	seen := make(chan struct{}, 1)
	go func() {
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			if strings.TrimSpace(scanner.Text()) == "event: diff" {
				seen <- struct{}{}
				return
			}
		}
	}()

	writeFile(t, filepath.Join(dir, "tracked.txt"), "one\ntwo\n")

	select {
	case <-seen:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for diff event")
	}
}

func TestOnChangeRunsOnLocalFileChange(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init")
	git(t, dir, "config", "user.email", "test@example.com")
	git(t, dir, "config", "user.name", "Test")
	writeFile(t, filepath.Join(dir, "tracked.txt"), "one\n")
	git(t, dir, "add", "tracked.txt")
	git(t, dir, "commit", "-m", "init")

	changed := make(chan []string, 1)
	handler, err := New(Config{
		CWD: dir,
		OnChange: func(paths []string) {
			select {
			case changed <- paths:
			default:
			}
		},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	ts := httptest.NewServer(handler)
	defer ts.Close()

	writeFile(t, filepath.Join(dir, "tracked.txt"), "one\ntwo\n")

	select {
	case paths := <-changed:
		if len(paths) != 1 || paths[0] != "tracked.txt" {
			t.Fatalf("change paths = %v, want [tracked.txt]", paths)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for change callback")
	}
}

func TestLocalWatcherIgnoresChmodEvents(t *testing.T) {
	dir := t.TempDir()
	w := &localWatcher{cwd: dir}
	event := fsnotify.Event{Name: filepath.Join(dir, "tracked.txt"), Op: fsnotify.Chmod}

	if w.shouldSchedule(event) {
		t.Fatal("chmod-only events should not schedule refreshes")
	}
}

func TestLocalWatcherIgnoresGitDirectory(t *testing.T) {
	dir := t.TempDir()
	w := &localWatcher{cwd: dir}
	name := filepath.Join(dir, ".git", "HEAD")

	if !w.ignore(name) {
		t.Fatal(".git paths should be ignored")
	}
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, out)
	}
}

func writeFile(t *testing.T, name, content string) {
	t.Helper()
	if err := os.WriteFile(name, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
