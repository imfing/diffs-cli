package comments

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestStoreAddReplyResolveAndReopen(t *testing.T) {
	dir := newGitRepo(t)
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	store.now = func() time.Time { return time.Date(2026, 5, 23, 12, 0, 0, 0, time.UTC) }

	thread, err := store.AddThread(context.Background(), AddThreadInput{
		Path:    "web/src/App.tsx",
		Line:    42,
		EndLine: 45,
		Side:    "additions",
		Body:    "Check this",
	})
	if err != nil {
		t.Fatalf("AddThread() error = %v", err)
	}
	if thread.ID == "" || thread.Provider != "local" || thread.Status != "open" || thread.Branch != "main" {
		t.Fatalf("unexpected thread metadata: %+v", thread)
	}
	if thread.Line != 42 || thread.EndLine != 45 || thread.Side != "additions" || thread.EndSide != "additions" {
		t.Fatalf("unexpected thread range: %+v", thread)
	}
	if len(thread.Comments) != 1 || thread.Comments[0].Body != "Check this" || thread.Comments[0].Author != "Test" {
		t.Fatalf("unexpected comments: %+v", thread.Comments)
	}

	thread, err = store.AddReply(context.Background(), thread.ID, AddReplyInput{Body: "Reply", Author: "agent"})
	if err != nil {
		t.Fatalf("AddReply() error = %v", err)
	}
	if len(thread.Comments) != 2 || thread.Comments[1].Body != "Reply" || thread.Comments[1].Author != "agent" {
		t.Fatalf("reply was not appended: %+v", thread.Comments)
	}

	thread, err = store.Resolve(context.Background(), thread.ID)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if thread.Status != "resolved" {
		t.Fatalf("status = %q, want resolved", thread.Status)
	}

	thread, err = store.Reopen(context.Background(), thread.ID)
	if err != nil {
		t.Fatalf("Reopen() error = %v", err)
	}
	if thread.Status != "open" {
		t.Fatalf("status = %q, want open", thread.Status)
	}

	if err := store.Delete(context.Background(), thread.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	threads, err := store.List(context.Background())
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(threads) != 0 {
		t.Fatalf("threads = %+v, want deleted thread removed", threads)
	}
}

func TestStoreFallsBackToLocalAuthorWithoutGitConfig(t *testing.T) {
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	thread, err := store.AddThread(context.Background(), AddThreadInput{
		Path: "web/src/App.tsx",
		Line: 42,
		Body: "Check this",
	})
	if err != nil {
		t.Fatalf("AddThread() error = %v", err)
	}
	if len(thread.Comments) != 1 || thread.Comments[0].Author != DefaultAuthor {
		t.Fatalf("unexpected comments: %+v", thread.Comments)
	}
}

func TestStoreListsCurrentBranchOnly(t *testing.T) {
	dir := newGitRepo(t)
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if _, err := store.AddThread(context.Background(), AddThreadInput{Path: "a.go", Line: 1, Body: "main"}); err != nil {
		t.Fatal(err)
	}

	git(t, dir, "checkout", "-b", "feature/comments")
	if _, err := store.AddThread(context.Background(), AddThreadInput{Path: "b.go", Line: 1, Body: "feature"}); err != nil {
		t.Fatal(err)
	}

	threads, err := store.List(context.Background())
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(threads) != 1 || threads[0].Path != "b.go" {
		t.Fatalf("threads = %+v, want only feature branch thread", threads)
	}
}

func TestStoreKeepsConcurrentAdds(t *testing.T) {
	dir := newGitRepo(t)
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}

	const count = 20
	errs := make(chan error, count)
	var wg sync.WaitGroup
	for i := range count {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := store.AddThread(context.Background(), AddThreadInput{
				Path: fmt.Sprintf("file-%02d.go", i),
				Line: 1,
				Body: "body",
			})
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("AddThread() error = %v", err)
		}
	}

	threads, err := store.List(context.Background())
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(threads) != count {
		t.Fatalf("thread count = %d, want %d", len(threads), count)
	}
}

func TestStoreReturnsNotFoundForOtherBranch(t *testing.T) {
	dir := newGitRepo(t)
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	thread, err := store.AddThread(context.Background(), AddThreadInput{Path: "a.go", Line: 1, Body: "main"})
	if err != nil {
		t.Fatal(err)
	}

	git(t, dir, "checkout", "-b", "feature/comments")
	_, err = store.Resolve(context.Background(), thread.ID)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("Resolve() error = %v, want ErrNotFound", err)
	}
}

func TestStoreRejectsInvalidThreadInput(t *testing.T) {
	for _, input := range []AddThreadInput{
		{Path: "", Line: 1, Body: "body"},
		{Path: "../outside", Line: 1, Body: "body"},
		{Path: "a/../../outside", Line: 1, Body: "body"},
		{Path: `a\..\..\outside`, Line: 1, Body: "body"},
		{Path: "a.go", Line: 0, Body: "body"},
		{Path: "a.go", Line: 1, EndLine: -1, Body: "body"},
		{Path: "a.go", Line: 10, EndLine: 1, Body: "body"},
		{Path: "a.go", Line: 1, Side: "right", Body: "body"},
		{Path: "a.go", Line: 1, EndSide: "right", Body: "body"},
		{Path: "a.go", Line: 1, Body: ""},
	} {
		t.Run(input.Path, func(t *testing.T) {
			if _, _, _, _, _, _, err := cleanThreadInput(input.Path, input.Side, input.Line, input.EndSide, input.EndLine, input.Body); err == nil {
				t.Fatalf("cleanThreadInput(%+v) succeeded, want error", input)
			}
		})
	}
}

func newGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")
	git(t, dir, "config", "user.email", "test@example.com")
	git(t, dir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("test\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", "README.md")
	git(t, dir, "commit", "-m", "init")
	return dir
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
