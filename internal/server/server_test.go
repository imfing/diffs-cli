package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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

func TestMain(m *testing.M) {
	for k, v := range map[string]string{
		"GIT_AUTHOR_NAME":     "Test",
		"GIT_AUTHOR_EMAIL":    "test@example.com",
		"GIT_COMMITTER_NAME":  "Test",
		"GIT_COMMITTER_EMAIL": "test@example.com",
	} {
		_ = os.Setenv(k, v)
	}
	os.Exit(m.Run())
}

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
	git(t, dir, "config", "user.name", "Test")
	git(t, dir, "checkout", "-b", "feature/comments")
	handler, err := New(Config{CWD: dir})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	addReq := httptest.NewRequest(http.MethodPost, "/api/comments", bytes.NewBufferString(`{
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

	replyReq := httptest.NewRequest(http.MethodPost, "/api/comments/"+thread.ID+"/replies", bytes.NewBufferString(`{"body":"Agreed"}`))
	replyRec := httptest.NewRecorder()
	handler.ServeHTTP(replyRec, replyReq)
	if replyRec.Code != http.StatusOK {
		t.Fatalf("reply status = %d, body = %s", replyRec.Code, replyRec.Body.String())
	}
	var replied struct {
		Comments []struct {
			Author string `json:"author"`
			Body   string `json:"body"`
		} `json:"comments"`
	}
	if err := json.NewDecoder(replyRec.Body).Decode(&replied); err != nil {
		t.Fatal(err)
	}
	if len(replied.Comments) != 2 || replied.Comments[1].Author != "Test" || replied.Comments[1].Body != "Agreed" {
		t.Fatalf("unexpected reply comments: %+v", replied.Comments)
	}

	resolveReq := httptest.NewRequest(http.MethodPost, "/api/comments/"+thread.ID+"/resolve", nil)
	resolveRec := httptest.NewRecorder()
	handler.ServeHTTP(resolveRec, resolveReq)
	if resolveRec.Code != http.StatusOK {
		t.Fatalf("resolve status = %d, body = %s", resolveRec.Code, resolveRec.Body.String())
	}

	listReq := httptest.NewRequest(http.MethodGet, "/api/comments", nil)
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

	deleteReq := httptest.NewRequest(http.MethodDelete, "/api/comments/"+thread.ID, nil)
	deleteRec := httptest.NewRecorder()
	handler.ServeHTTP(deleteRec, deleteReq)
	if deleteRec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", deleteRec.Code, deleteRec.Body.String())
	}

	listRec = httptest.NewRecorder()
	handler.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list after delete status = %d, body = %s", listRec.Code, listRec.Body.String())
	}
	if err := json.NewDecoder(listRec.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Threads) != 0 {
		t.Fatalf("list after delete = %+v, want no threads", list.Threads)
	}
}

func TestGitHubCommentsAPIListsReviewThreads(t *testing.T) {
	restore := stubGH(t, func(_ context.Context, args ...string) ([]byte, error) {
		if len(args) >= 2 && args[0] == "api" && args[1] == "graphql" {
			return []byte(`{
				"data": {
					"repository": {
						"pullRequest": {
							"reviewThreads": {
								"pageInfo": {"hasNextPage": false, "endCursor": ""},
								"nodes": [{
									"id": "PRRT_kwDO",
									"isResolved": false,
									"path": "web/src/App.tsx",
									"line": 42,
									"comments": {
										"nodes": [{
											"id": "PRRC_kwDO",
											"databaseId": 1001,
											"author": {"login": "octocat"},
											"body": "Looks odd",
											"path": "web/src/App.tsx",
											"line": 42,
											"side": "RIGHT",
											"url": "https://github.com/o/r/pull/1#discussion",
											"createdAt": "2026-05-23T12:00:00Z"
										}]
									}
								}]
							}
						}
					}
				}
			}`), nil
		}
		t.Fatalf("unexpected gh args: %v", args)
		return nil, nil
	})
	defer restore()

	handler, err := New(Config{CWD: t.TempDir()})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/comments?org=org&repo=repo&number=123", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var response struct {
		Threads []struct {
			ID        string `json:"id"`
			Provider  string `json:"provider"`
			Path      string `json:"path"`
			Line      int    `json:"line"`
			Side      string `json:"side"`
			Status    string `json:"status"`
			ReplyToID int64  `json:"replyToId"`
			Comments  []struct {
				Author string `json:"author"`
				Body   string `json:"body"`
			} `json:"comments"`
		} `json:"threads"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if len(response.Threads) != 1 {
		t.Fatalf("threads = %+v, want one thread", response.Threads)
	}
	thread := response.Threads[0]
	if thread.ID != "PRRT_kwDO" || thread.Provider != "github" || thread.Path != "web/src/App.tsx" || thread.Line != 42 || thread.Side != "additions" || thread.Status != "open" || thread.ReplyToID != 1001 {
		t.Fatalf("unexpected thread: %+v", thread)
	}
	if len(thread.Comments) != 1 || thread.Comments[0].Author != "octocat" || thread.Comments[0].Body != "Looks odd" {
		t.Fatalf("unexpected comments: %+v", thread.Comments)
	}
}

func TestGitHubPullRequestInfo(t *testing.T) {
	restore := stubGH(t, func(_ context.Context, args ...string) ([]byte, error) {
		if strings.Contains(strings.Join(args, " "), "repos/org/repo/pulls/123") {
			return []byte(`{
				"title": "Add compact PR header",
				"state": "open",
				"draft": false,
				"merged": false,
				"user": {"login": "octocat"},
				"created_at": "2026-05-22T12:00:00Z",
				"updated_at": "2026-05-23T12:00:00Z",
				"additions": 10,
				"deletions": 2,
				"changed_files": 3,
				"commits": 4,
				"head": {
					"sha": "abc123",
					"ref": "feature",
					"label": "contrib:feature",
					"repo": {"full_name": "contrib/repo"}
				},
				"base": {
					"ref": "main",
					"label": "org:main",
					"repo": {"full_name": "org/repo"}
				}
			}`), nil
		}
		t.Fatalf("unexpected gh args: %v", args)
		return nil, nil
	})
	defer restore()

	handler, err := New(Config{CWD: t.TempDir()})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/pull/org/repo/123", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Title        string `json:"title"`
		State        string `json:"state"`
		Author       string `json:"author"`
		Additions    int    `json:"additions"`
		Deletions    int    `json:"deletions"`
		ChangedFiles int    `json:"changedFiles"`
		Commits      int    `json:"commits"`
		HeadRef      string `json:"headRef"`
		HeadLabel    string `json:"headLabel"`
		HeadRepo     string `json:"headRepo"`
		BaseRef      string `json:"baseRef"`
		BaseLabel    string `json:"baseLabel"`
		BaseRepo     string `json:"baseRepo"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Title != "Add compact PR header" || got.State != "open" || got.Author != "octocat" ||
		got.Additions != 10 || got.Deletions != 2 || got.ChangedFiles != 3 || got.Commits != 4 ||
		got.HeadRef != "feature" || got.HeadLabel != "contrib:feature" || got.HeadRepo != "contrib/repo" ||
		got.BaseRef != "main" || got.BaseLabel != "org:main" || got.BaseRepo != "org/repo" {
		t.Fatalf("unexpected pull request info: %+v", got)
	}
}

func TestGitHubCommentsAPICreatesReviewComment(t *testing.T) {
	var createdArgs []string
	restore := stubGH(t, func(_ context.Context, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "repos/org/repo/pulls/123") && !strings.Contains(joined, "comments"):
			return []byte(`{"head":{"sha":"abc123"}}`), nil
		case strings.Contains(joined, "repos/org/repo/pulls/123/comments"):
			createdArgs = append([]string(nil), args...)
			return []byte(`{"id":1001,"node_id":"PRRC_kwDO"}`), nil
		case len(args) >= 2 && args[0] == "api" && args[1] == "graphql":
			return []byte(githubReviewThreadsFixture(false)), nil
		default:
			t.Fatalf("unexpected gh args: %v", args)
			return nil, nil
		}
	})
	defer restore()

	handler, err := New(Config{CWD: t.TempDir()})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/comments?org=org&repo=repo&number=123", bytes.NewBufferString(`{
		"path": "web/src/App.tsx",
		"line": 40,
		"endLine": 42,
		"side": "additions",
		"body": "Looks odd"
	}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	for _, want := range []string{
		"body=Looks odd",
		"commit_id=abc123",
		"path=web/src/App.tsx",
		"line=42",
		"start_line=40",
	} {
		if !containsArg(createdArgs, want) {
			t.Fatalf("create args missing %q: %v", want, createdArgs)
		}
	}
}

func TestGitHubCommentsAPIResolvesReviewThread(t *testing.T) {
	var sawResolve bool
	restore := stubGH(t, func(_ context.Context, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		if strings.Contains(joined, "resolveReviewThread") {
			sawResolve = true
			if !containsArg(args, "threadID=PRRT_kwDO") {
				t.Fatalf("resolve args missing thread id: %v", args)
			}
			return []byte(`{"data":{"resolveReviewThread":{"thread":{"id":"PRRT_kwDO","isResolved":true}}}}`), nil
		}
		if len(args) >= 2 && args[0] == "api" && args[1] == "graphql" {
			return []byte(githubReviewThreadsFixture(true)), nil
		}
		t.Fatalf("unexpected gh args: %v", args)
		return nil, nil
	})
	defer restore()

	handler, err := New(Config{CWD: t.TempDir()})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/comments/PRRT_kwDO/resolve?org=org&repo=repo&number=123", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !sawResolve {
		t.Fatal("resolveReviewThread mutation was not called")
	}
	var thread struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&thread); err != nil {
		t.Fatal(err)
	}
	if thread.Status != "resolved" {
		t.Fatalf("status = %q, want resolved", thread.Status)
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

func stubGH(t *testing.T, fn func(context.Context, ...string) ([]byte, error)) func() {
	t.Helper()
	previous := runGH
	runGH = fn
	return func() {
		runGH = previous
	}
}

func containsArg(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}

func githubReviewThreadsFixture(resolved bool) string {
	return fmt.Sprintf(`{
		"data": {
			"repository": {
				"pullRequest": {
					"reviewThreads": {
						"pageInfo": {"hasNextPage": false, "endCursor": ""},
						"nodes": [{
							"id": "PRRT_kwDO",
							"isResolved": %t,
							"path": "web/src/App.tsx",
							"line": 42,
							"comments": {
								"nodes": [{
									"id": "PRRC_kwDO",
									"databaseId": 1001,
									"author": {"login": "octocat"},
									"body": "Looks odd",
									"path": "web/src/App.tsx",
									"line": 42,
									"side": "RIGHT",
									"url": "https://github.com/o/r/pull/1#discussion",
									"createdAt": "2026-05-23T12:00:00Z"
								}]
							}
						}]
					}
				}
			}
		}
	}`, resolved)
}
