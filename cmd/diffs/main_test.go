package main

import (
	"bytes"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/imfing/diffs-cli/internal/comments"
	"github.com/imfing/diffs-cli/internal/server"
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

func TestTargetPathFromArgs(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{name: "path", args: []string{"/org/repo/pull/123"}, want: "/org/repo/pull/123"},
		{name: "path without leading slash", args: []string{"org/repo/pull/123"}, want: "/org/repo/pull/123"},
		{name: "url", args: []string{"https://github.com/org/repo/pull/123"}, want: "/org/repo/pull/123"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := targetPathFromArgs(tt.args)
			if err != nil {
				t.Fatalf("targetPathFromArgs() error = %v", err)
			}
			if got != tt.want {
				t.Fatalf("targetPathFromArgs() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestPRTargetFromArgsIncludesURLHost(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		wantPath string
		wantHost string
	}{
		{name: "path", args: []string{"/org/repo/pull/123"}, wantPath: "/org/repo/pull/123"},
		{name: "path without leading slash", args: []string{"org/repo/pull/123"}, wantPath: "/org/repo/pull/123"},
		{name: "github url", args: []string{"https://github.com/org/repo/pull/123"}, wantPath: "/org/repo/pull/123", wantHost: "github.com"},
		{name: "enterprise url", args: []string{"https://github.example.com/org/repo/pull/123"}, wantPath: "/org/repo/pull/123", wantHost: "github.example.com"},
		{name: "enterprise url with port", args: []string{"https://github.example.com:8443/org/repo/pull/123"}, wantPath: "/org/repo/pull/123", wantHost: "github.example.com"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := prTargetFromArgs(tt.args)
			if err != nil {
				t.Fatalf("prTargetFromArgs() error = %v", err)
			}
			if got.Path != tt.wantPath || got.Host != tt.wantHost {
				t.Fatalf("prTargetFromArgs() = %+v, want path %q host %q", got, tt.wantPath, tt.wantHost)
			}
		})
	}
}

func TestResolveGitHubHostPrefersURLHostWhenFlagOmitted(t *testing.T) {
	cmd := newRootCommand(time.Time{})
	prCmd, _, err := cmd.Find([]string{"pr"})
	if err != nil {
		t.Fatal(err)
	}
	opts := &cliOptions{ghHost: "github.com"}

	got := opts.withResolvedGitHubHost(prCmd, "github.example.com")
	if got.ghHost != "github.example.com" {
		t.Fatalf("ghHost = %q, want URL host", got.ghHost)
	}
	if opts.ghHost != "github.com" {
		t.Fatalf("original ghHost mutated to %q", opts.ghHost)
	}
}

func TestResolveGitHubHostKeepsExplicitFlag(t *testing.T) {
	cmd := newRootCommand(time.Time{})
	prCmd, _, err := cmd.Find([]string{"pr"})
	if err != nil {
		t.Fatal(err)
	}
	if err := prCmd.Flags().Set("gh-host", "explicit.example.com"); err != nil {
		t.Fatal(err)
	}
	opts := &cliOptions{ghHost: "explicit.example.com"}

	got := opts.withResolvedGitHubHost(prCmd, "url.example.com")
	if got.ghHost != "explicit.example.com" {
		t.Fatalf("ghHost = %q, want explicit flag host", got.ghHost)
	}
}

func TestTargetPathFromArgsRejectsInvalidTarget(t *testing.T) {
	tests := [][]string{
		nil,
		{""},
		{"org/repo/issues/123"},
	}
	for _, args := range tests {
		if _, err := targetPathFromArgs(args); err == nil {
			t.Fatalf("targetPathFromArgs(%v) succeeded, want error", args)
		}
	}
}

func TestRootCommandRejectsDirectPRTarget(t *testing.T) {
	cmd := newRootCommand(time.Time{})
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})
	cmd.SetArgs([]string{"/org/repo/pull/123"})
	if err := cmd.Execute(); err == nil {
		t.Fatal("root command accepted direct PR target, want explicit pr subcommand")
	}
}

func TestLocalCommandRejectsNonGitRepository(t *testing.T) {
	dir := t.TempDir()
	var errOut bytes.Buffer
	cmd := newRootCommand(time.Time{})
	cmd.SetOut(&errOut)
	cmd.SetErr(&errOut)
	cmd.SetArgs([]string{"--dir", dir, "--no-open"})
	err := cmd.Execute()
	if err == nil {
		t.Fatal("local command succeeded outside git repository")
	}
	if !strings.Contains(err.Error(), "not a git repository") {
		t.Fatalf("error = %v, want not a git repository", err)
	}
	got := errOut.String()
	for _, want := range []string{
		"error    not a git repository: " + dir,
		"hint     run from a git repository",
		"hint     or pass --dir /path/to/repo",
		"hint     or use diffs pr /org/repo/pull/123",
		"Usage:",
		"diffs [flags]",
		"Available Commands:",
		"local",
		"pr",
		"--dir string",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("git help missing %q in:\n%s", want, got)
		}
	}
}

func TestGitRootAcceptsGitRepository(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")

	got, err := gitRoot(dir)
	if err != nil {
		t.Fatalf("gitRoot() error = %v", err)
	}
	want, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("EvalSymlinks() error = %v", err)
	}
	if got != want {
		t.Fatalf("gitRoot() = %q, want %q", got, want)
	}
}

func TestNormalizeListenAddrPrefersIPv4Loopback(t *testing.T) {
	if got := normalizeListenAddr("localhost:3433"); got != "127.0.0.1:3433" {
		t.Fatalf("normalizeListenAddr() = %q, want %q", got, "127.0.0.1:3433")
	}
}

func TestListenAddrFromOptionsUsesHostAndPort(t *testing.T) {
	got, err := listenAddrFromOptions("localhost", 4321)
	if err != nil {
		t.Fatalf("listenAddrFromOptions() error = %v", err)
	}
	if got != "127.0.0.1:4321" {
		t.Fatalf("listenAddrFromOptions() = %q, want %q", got, "127.0.0.1:4321")
	}
}

func TestListenAddrFromOptionsRejectsInvalidPort(t *testing.T) {
	if _, err := listenAddrFromOptions("127.0.0.1", 70000); err == nil {
		t.Fatal("expected invalid port to fail")
	}
}

func TestListenWithPortFallbackUsesRandomPortWhenBusy(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen occupied port: %v", err)
	}
	defer occupied.Close()

	ln, fallback, err := listenWithPortFallback(occupied.Addr().String())
	if err != nil {
		t.Fatalf("listenWithPortFallback() error = %v", err)
	}
	defer ln.Close()
	if fallback == nil {
		t.Fatal("listenWithPortFallback() fallback = nil, want fallback")
	}
	if fallback.Requested != occupied.Addr().String() {
		t.Fatalf("fallback requested = %q, want %q", fallback.Requested, occupied.Addr().String())
	}
	if fallback.Actual != ln.Addr().String() {
		t.Fatalf("fallback actual = %q, want %q", fallback.Actual, ln.Addr().String())
	}
	if fallback.Actual == fallback.Requested {
		t.Fatalf("fallback reused busy address %q", fallback.Actual)
	}
}

func TestBrowserURLUsesLoopbackForWildcard(t *testing.T) {
	got := browserURL(&net.TCPAddr{IP: net.IPv4zero, Port: 3433}, "/local")
	if got != "http://127.0.0.1:3433/local" {
		t.Fatalf("browserURL() = %q, want %q", got, "http://127.0.0.1:3433/local")
	}
}

func TestTargetLabel(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init")
	git(t, dir, "checkout", "-b", "feature/startup")

	tests := []struct {
		path string
		cwd  string
		want string
	}{
		{path: "/local", cwd: dir, want: "feature/startup"},
		{path: "/org/repo/pull/123", cwd: dir, want: "GitHub PR org/repo#123"},
		{path: "/local", cwd: filepath.Join(dir, "missing"), want: "local repository"},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := targetLabel(tt.path, tt.cwd); got != tt.want {
				t.Fatalf("targetLabel() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestPrintStartup(t *testing.T) {
	var out bytes.Buffer
	printStartup(&out, startupInfo{
		URL:      "http://127.0.0.1:3433/local",
		Target:   "feature/startup",
		CWD:      "/repo",
		Watching: true,
		Elapsed:  12 * time.Millisecond,
	}, false)

	got := out.String()
	for _, want := range []string{
		"diffs    ready in 12 ms",
		"serve    http://127.0.0.1:3433/local",
		"target   feature/startup",
		"watch    /repo",
		"stop     Ctrl+C",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("printStartup() missing %q in:\n%s", want, got)
		}
	}
}

func TestPrintPortFallback(t *testing.T) {
	var out bytes.Buffer
	printPortFallback(&out, "127.0.0.1:3433", "127.0.0.1:52624", false)
	got := out.String()
	if !strings.Contains(got, "warn     127.0.0.1:3433 in use; using 127.0.0.1:52624") {
		t.Fatalf("printPortFallback() = %q", got)
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

func TestPrintReload(t *testing.T) {
	var out bytes.Buffer
	printReload(&out, time.Date(2026, 5, 23, 14, 15, 16, 0, time.Local), []server.ChangedFile{{Action: server.ChangeModified, Path: "web/src/App.tsx"}}, false)

	got := out.String()
	for _, want := range []string{"modified web/src/App.tsx"} {
		if !strings.Contains(got, want) {
			t.Fatalf("printReload() missing %q in %q", want, got)
		}
	}
	if strings.Contains(got, "(+") || strings.Contains(got, " -") {
		t.Fatalf("printReload() should not include line stats: %q", got)
	}
	if strings.Contains(got, "14:15:16") || strings.Contains(got, "[diffs]") || strings.Contains(got, "reload") || strings.Contains(got, "change") {
		t.Fatalf("printReload() should not include timestamp, bracketed prefix, or extra reload line: %q", got)
	}
}

func TestReloadLoggerCoalescesBursts(t *testing.T) {
	var out bytes.Buffer
	reload := newReloadLogger(&out, false)
	now := time.Date(2026, 5, 23, 14, 15, 16, 0, time.Local)

	reload(now, []server.ChangedFile{{Action: server.ChangeModified, Path: "one.go"}})
	reload(now.Add(100*time.Millisecond), []server.ChangedFile{{Action: server.ChangeModified, Path: "two.go"}})
	reload(now.Add(600*time.Millisecond), []server.ChangedFile{{Action: server.ChangeModified, Path: "three.go"}})

	if got := strings.Count(out.String(), "modified"); got != 2 {
		t.Fatalf("reload log count = %d, want 2:\n%s", got, out.String())
	}
}

func TestReloadLineSummarizesMultiplePaths(t *testing.T) {
	label, message := reloadLine([]server.ChangedFile{
		{Action: server.ChangeAdded, Path: "a.go"},
		{Action: server.ChangeModified, Path: "b.go"},
		{Action: server.ChangeDeleted, Path: "c.go"},
	}, terminalColors{}, false)
	if label != "added" || message != "a.go (+2 more)" {
		t.Fatalf("reloadLine() = %q, %q; want added, a.go (+2 more)", label, message)
	}
}

func TestReloadLineColorsPath(t *testing.T) {
	c := terminalColors{cyan: "C", reset: "Z"}
	label, message := reloadLine([]server.ChangedFile{
		{Action: server.ChangeModified, Path: "a.go"},
	}, c, true)
	want := "Ca.goZ"
	if label != "modified" || message != want {
		t.Fatalf("reloadLine() = %q, %q; want modified, %q", label, message, want)
	}
}

func TestReloadLineFallsBackToChangeLabel(t *testing.T) {
	label, message := reloadLine([]server.ChangedFile{
		{Path: "a.go"},
		{Path: "b.go"},
		{Path: "c.go"},
	}, terminalColors{}, false)
	want := "a.go (+2 more)"
	if label != "change" || message != want {
		t.Fatalf("reloadLine() = %q, %q; want change, %q", label, message, want)
	}
}

func TestLatestCommentBodyTruncatesUTF8Safely(t *testing.T) {
	body := strings.Repeat("评", 80) + " done"
	got := latestCommentBody(comments.Thread{
		Comments: []comments.Comment{{Body: body}},
	})
	if !utf8.ValidString(got) {
		t.Fatalf("latestCommentBody() returned invalid UTF-8: %q", got)
	}
	if strings.Count(got, "评") != 69 || !strings.HasSuffix(got, "...") {
		t.Fatalf("latestCommentBody() = %q, want 69 runes plus ellipsis", got)
	}
}

func TestRootCommandHelpShowsSubcommandsAndDir(t *testing.T) {
	var out bytes.Buffer
	cmd := newRootCommand(time.Time{})
	cmd.SetOut(&out)
	cmd.SetErr(&bytes.Buffer{})
	cmd.SetArgs([]string{"--help"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("help failed: %v", err)
	}

	got := out.String()
	for _, want := range []string{
		"diffs [flags]",
		"local",
		"pr",
		"--dir string",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("help output missing %q in:\n%s", want, got)
		}
	}
	if strings.Contains(got, "--github-host") {
		t.Fatalf("root help output should not include pr-only flag --github-host:\n%s", got)
	}
	if strings.Contains(got, "--gh-host") {
		t.Fatalf("root help output should not include pr-only flag --gh-host:\n%s", got)
	}
}

func TestPRCommandHelp(t *testing.T) {
	var out bytes.Buffer
	cmd := newRootCommand(time.Time{})
	cmd.SetOut(&out)
	cmd.SetErr(&bytes.Buffer{})
	cmd.SetArgs([]string{"pr", "--help"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("pr help failed: %v", err)
	}

	got := out.String()
	for _, want := range []string{
		"diffs pr [github-pr-url|/org/repo/pull/123]",
		"--host string",
		"--gh-host string",
		"--port int",
		"--dir string",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("pr help output missing %q in:\n%s", want, got)
		}
	}
	if strings.Contains(got, "--github-host") {
		t.Fatalf("pr help output should not include removed flag --github-host:\n%s", got)
	}
}

func TestCommentsCommandAddAndListJSON(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-b", "main")

	var addOut bytes.Buffer
	addCmd := newRootCommand(time.Time{})
	addCmd.SetOut(&addOut)
	addCmd.SetErr(&bytes.Buffer{})
	addCmd.SetArgs([]string{
		"--dir", dir,
		"comments", "--json", "add",
		"--file", "web/src/App.tsx",
		"--line", "42",
		"--body", "Looks suspicious",
		"--author", "agent",
	})
	if err := addCmd.Execute(); err != nil {
		t.Fatalf("comments add failed: %v", err)
	}
	var added struct {
		ID       string `json:"id"`
		Path     string `json:"path"`
		Line     int    `json:"line"`
		Status   string `json:"status"`
		Comments []struct {
			Author string `json:"author"`
			Body   string `json:"body"`
		} `json:"comments"`
	}
	if err := json.Unmarshal(addOut.Bytes(), &added); err != nil {
		t.Fatalf("decode add json: %v\n%s", err, addOut.String())
	}
	if added.ID == "" || added.Path != "web/src/App.tsx" || added.Line != 42 || added.Status != "open" {
		t.Fatalf("unexpected added thread: %+v", added)
	}
	if len(added.Comments) != 1 || added.Comments[0].Author != "agent" || added.Comments[0].Body != "Looks suspicious" {
		t.Fatalf("unexpected added comments: %+v", added.Comments)
	}

	var listOut bytes.Buffer
	listCmd := newRootCommand(time.Time{})
	listCmd.SetOut(&listOut)
	listCmd.SetErr(&bytes.Buffer{})
	listCmd.SetArgs([]string{"--dir", dir, "comments", "--json", "list"})
	if err := listCmd.Execute(); err != nil {
		t.Fatalf("comments list failed: %v", err)
	}
	var listed struct {
		Threads []struct {
			ID string `json:"id"`
		} `json:"threads"`
	}
	if err := json.Unmarshal(listOut.Bytes(), &listed); err != nil {
		t.Fatalf("decode list json: %v\n%s", err, listOut.String())
	}
	if len(listed.Threads) != 1 || listed.Threads[0].ID != added.ID {
		t.Fatalf("listed threads = %+v, want %s", listed.Threads, added.ID)
	}
}
