package server

import (
	"bufio"
	"bytes"
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
	"github.com/imfing/diffs-cli/internal/appconfig"
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

func TestConfigIncludesUISettingsWhenConfigured(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init")

	wordWrap := true
	lineNumbers := false
	lineBackgrounds := true
	handler, err := New(Config{
		CWD: dir,
		UI: appconfig.UIConfig{
			ColorScheme:     "dark",
			DiffTheme:       "github",
			DiffStyle:       "unified",
			WordWrap:        &wordWrap,
			LineNumbers:     &lineNumbers,
			LineBackgrounds: &lineBackgrounds,
		},
	})
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
		ColorScheme     string `json:"colorScheme"`
		DiffTheme       string `json:"diffTheme"`
		DiffStyle       string `json:"diffStyle"`
		WordWrap        bool   `json:"wordWrap"`
		LineNumbers     bool   `json:"lineNumbers"`
		LineBackgrounds bool   `json:"lineBackgrounds"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.ColorScheme != "dark" {
		t.Fatalf("colorScheme = %q, want dark", got.ColorScheme)
	}
	if got.DiffTheme != "github" || got.DiffStyle != "unified" || !got.WordWrap || got.LineNumbers || !got.LineBackgrounds {
		t.Fatalf("unexpected UI config: %+v", got)
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

func TestGitDiffNoIndexUsesDevNullHeader(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "new.txt"), "hello\n")

	patch, err := (&Server{cwd: dir}).gitDiffNoIndex(context.Background(), "new.txt")
	if err != nil {
		t.Fatalf("gitDiffNoIndex() error = %v", err)
	}
	if !strings.Contains(patch, "--- /dev/null") {
		t.Fatalf("gitDiffNoIndex() patch missing /dev/null header:\n%s", patch)
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

	handler, err := New(Config{CWD: dir, Watch: true})
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
	defer func() { _ = resp.Body.Close() }()
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

	changed := make(chan []ChangedFile, 1)
	handler, err := New(Config{
		CWD:   dir,
		Watch: true,
		OnChange: func(paths []ChangedFile) {
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
		want := []ChangedFile{{Path: "tracked.txt", Action: ChangeModified}}
		if len(paths) != len(want) || paths[0] != want[0] {
			t.Fatalf("change paths = %+v, want %+v", paths, want)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for change callback")
	}
}

func TestOnChangeIgnoresGitCleanBuildOutput(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init")
	writeFile(t, filepath.Join(dir, ".gitignore"), "web/dist/\n")
	git(t, dir, "add", ".gitignore")
	git(t, dir, "commit", "-m", "init")
	writeFile(t, filepath.Join(dir, ".gitignore"), "web/dist/\n*.log\n")
	if err := os.MkdirAll(filepath.Join(dir, "web", "dist", "assets"), 0o755); err != nil {
		t.Fatal(err)
	}

	changed := make(chan []ChangedFile, 1)
	handler, err := New(Config{
		CWD:   dir,
		Watch: true,
		OnChange: func(paths []ChangedFile) {
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

	writeFile(t, filepath.Join(dir, "web", "dist", "assets", "index.js"), "built\n")

	select {
	case paths := <-changed:
		t.Fatalf("change callback ran for git-ignored build output: %v", paths)
	case <-time.After(400 * time.Millisecond):
	}
}

func TestEventsStreamIgnoresGitCleanBuildOutput(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init")
	writeFile(t, filepath.Join(dir, ".gitignore"), "web/dist/\n")
	git(t, dir, "add", ".gitignore")
	git(t, dir, "commit", "-m", "init")
	if err := os.MkdirAll(filepath.Join(dir, "web", "dist", "assets"), 0o755); err != nil {
		t.Fatal(err)
	}

	handler, err := New(Config{CWD: dir, Watch: true})
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
	defer func() { _ = resp.Body.Close() }()

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

	writeFile(t, filepath.Join(dir, "web", "dist", "assets", "index.js"), "built\n")

	select {
	case <-seen:
		t.Fatal("received diff event for git-ignored build output")
	case <-time.After(400 * time.Millisecond):
	}
}

func TestWatcherDisabledDoesNotObserveLocalChanges(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init")
	git(t, dir, "config", "user.email", "test@example.com")
	git(t, dir, "config", "user.name", "Test")
	writeFile(t, filepath.Join(dir, "tracked.txt"), "one\n")
	git(t, dir, "add", "tracked.txt")
	git(t, dir, "commit", "-m", "init")

	changed := make(chan []ChangedFile, 1)
	handler, err := New(Config{
		CWD: dir,
		OnChange: func(paths []ChangedFile) {
			changed <- paths
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
		t.Fatalf("change callback ran with watcher disabled: %v", paths)
	case <-time.After(400 * time.Millisecond):
	}
}

func TestGitStatusReturnsChangedPaths(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init")
	writeFile(t, filepath.Join(dir, ".gitignore"), "web/dist/\n")
	writeFile(t, filepath.Join(dir, "tracked.txt"), "one\n")
	git(t, dir, "add", ".gitignore", "tracked.txt")
	git(t, dir, "commit", "-m", "init")

	writeFile(t, filepath.Join(dir, "tracked.txt"), "one\ntwo\n")
	writeFile(t, filepath.Join(dir, "new.txt"), "hello\n")
	if err := os.MkdirAll(filepath.Join(dir, "web", "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, "web", "dist", "bundle.js"), "built\n")

	got, err := gitStatus(dir)
	if err != nil {
		t.Fatalf("gitStatus() error = %v", err)
	}
	want := map[string]ChangeAction{
		"new.txt":     ChangeAdded,
		"tracked.txt": ChangeModified,
	}
	if len(got) != len(want) {
		t.Fatalf("gitStatus() = %+v, want %+v", got, want)
	}
	for path, action := range want {
		if got[path] != action {
			t.Fatalf("gitStatus()[%q] = %q, want %q", path, got[path], action)
		}
	}
}

func TestGitStatusActions(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init")
	writeFile(t, filepath.Join(dir, "tracked.txt"), "one\n")
	git(t, dir, "add", "tracked.txt")
	git(t, dir, "commit", "-m", "init")

	writeFile(t, filepath.Join(dir, "tracked.txt"), "one\ntwo\n")
	writeFile(t, filepath.Join(dir, "new.txt"), "hello\n")
	if err := os.Remove(filepath.Join(dir, "tracked.txt")); err != nil {
		t.Fatal(err)
	}

	got, err := gitStatus(dir)
	if err != nil {
		t.Fatalf("gitStatus() error = %v", err)
	}
	want := map[string]ChangeAction{
		"new.txt":     ChangeAdded,
		"tracked.txt": ChangeDeleted,
	}
	if len(got) != len(want) {
		t.Fatalf("gitStatus() = %+v, want %+v", got, want)
	}
	for path, action := range want {
		if got[path] != action {
			t.Fatalf("gitStatus()[%q] = %q, want %q", path, got[path], action)
		}
	}
}

func TestGitStatusUsesNewPathForRenames(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init")
	git(t, dir, "config", "user.email", "test@example.com")
	git(t, dir, "config", "user.name", "Test")
	writeFile(t, filepath.Join(dir, "old.txt"), "one\n")
	git(t, dir, "add", "old.txt")
	git(t, dir, "commit", "-m", "init")
	git(t, dir, "mv", "old.txt", "new.txt")

	got, err := gitStatus(dir)
	if err != nil {
		t.Fatalf("gitStatus() error = %v", err)
	}
	if got["new.txt"] != ChangeRenamed {
		t.Fatalf("gitStatus()[new.txt] = %q, want %q; full map: %+v", got["new.txt"], ChangeRenamed, got)
	}
	if _, ok := got["old.txt"]; ok {
		t.Fatalf("gitStatus() should not key renamed file by old path: %+v", got)
	}

	changed := changedFilesForEvents([]string{"new.txt"}, got)
	want := []ChangedFile{{Path: "new.txt", Action: ChangeRenamed}}
	if len(changed) != len(want) || changed[0] != want[0] {
		t.Fatalf("changedFilesForEvents() = %+v, want %+v", changed, want)
	}
}

func TestChangedFilesForEventsKeepsActions(t *testing.T) {
	got := changedFilesForEvents(
		[]string{"src"},
		map[string]ChangeAction{
			".gitignore": ChangeModified,
			"src/new.go": ChangeAdded,
		},
	)
	want := []ChangedFile{{Path: "src/new.go", Action: ChangeAdded}}
	if len(got) != len(want) || got[0] != want[0] {
		t.Fatalf("changedFilesForEvents() = %+v, want %+v", got, want)
	}
}

func TestSafePathPartRejectsOptionLikeParts(t *testing.T) {
	for _, part := range []string{"-h", "../org", "org/repo", `org\repo`, "bad space"} {
		if safePathPart(part) {
			t.Fatalf("safePathPart(%q) = true, want false", part)
		}
	}
	for _, part := range []string{"imfing", "diffs-cli", "repo.name", "repo_name"} {
		if !safePathPart(part) {
			t.Fatalf("safePathPart(%q) = false, want true", part)
		}
	}
}

func TestLocalCommentsAPI(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init")
	git(t, dir, "checkout", "-b", "feature/comments")
	handler, err := New(Config{CWD: dir})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	addReq := httptest.NewRequest(http.MethodPost, "/api/local-comments", bytes.NewBufferString(`{
		"path": "web/src/App.tsx",
		"line": 42,
		"side": "additions",
		"body": "Looks odd",
		"author": "agent"
	}`))
	addRec := httptest.NewRecorder()
	handler.ServeHTTP(addRec, addReq)
	if addRec.Code != http.StatusCreated {
		t.Fatalf("add status = %d, body = %s", addRec.Code, addRec.Body.String())
	}
	var thread struct {
		ID       string `json:"id"`
		Branch   string `json:"branch"`
		Path     string `json:"path"`
		Status   string `json:"status"`
		Comments []struct {
			Author string `json:"author"`
			Body   string `json:"body"`
		} `json:"comments"`
	}
	if err := json.NewDecoder(addRec.Body).Decode(&thread); err != nil {
		t.Fatal(err)
	}
	if thread.ID == "" || thread.Branch != "feature/comments" || thread.Path != "web/src/App.tsx" || thread.Status != "open" {
		t.Fatalf("unexpected thread: %+v", thread)
	}
	if len(thread.Comments) != 1 || thread.Comments[0].Author != "agent" || thread.Comments[0].Body != "Looks odd" {
		t.Fatalf("unexpected comments: %+v", thread.Comments)
	}

	replyReq := httptest.NewRequest(http.MethodPost, "/api/local-comments/"+thread.ID+"/replies", bytes.NewBufferString(`{"body":"Agreed"}`))
	replyRec := httptest.NewRecorder()
	handler.ServeHTTP(replyRec, replyReq)
	if replyRec.Code != http.StatusOK {
		t.Fatalf("reply status = %d, body = %s", replyRec.Code, replyRec.Body.String())
	}

	resolveReq := httptest.NewRequest(http.MethodPost, "/api/local-comments/"+thread.ID+"/resolve", nil)
	resolveRec := httptest.NewRecorder()
	handler.ServeHTTP(resolveRec, resolveReq)
	if resolveRec.Code != http.StatusOK {
		t.Fatalf("resolve status = %d, body = %s", resolveRec.Code, resolveRec.Body.String())
	}

	listReq := httptest.NewRequest(http.MethodGet, "/api/local-comments", nil)
	listRec := httptest.NewRecorder()
	handler.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", listRec.Code, listRec.Body.String())
	}
	var list struct {
		Threads []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"threads"`
	}
	if err := json.NewDecoder(listRec.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Threads) != 1 || list.Threads[0].ID != thread.ID || list.Threads[0].Status != "resolved" {
		t.Fatalf("list = %+v, want resolved thread", list.Threads)
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

func TestLocalWatcherIgnoresCommentTempFiles(t *testing.T) {
	dir := t.TempDir()
	w := &localWatcher{cwd: dir}
	name := filepath.Join(dir, ".diffs", ".comments-123.json")

	if !w.ignore(name) {
		t.Fatal("comment temp files should be ignored")
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
