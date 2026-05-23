package main

import (
	"bytes"
	"net"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTargetPathFromArgs(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{name: "default local", want: "/local"},
		{name: "explicit local", args: []string{"local"}, want: "/local"},
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

func TestTargetPathFromArgsRejectsInvalidTarget(t *testing.T) {
	if _, err := targetPathFromArgs([]string{"org/repo/issues/123"}); err == nil {
		t.Fatal("expected invalid target to fail")
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
		"DIFFS ready in 12 ms",
		"Local:   http://127.0.0.1:3433/local",
		"Target:  feature/startup",
		"Watch:   /repo",
		"Press Ctrl+C to stop.",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("printStartup() missing %q in:\n%s", want, got)
		}
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
	printReload(&out, time.Date(2026, 5, 23, 14, 15, 16, 0, time.Local), []string{"web/src/App.tsx"}, false)

	got := out.String()
	for _, want := range []string{"14:15:16", "[diffs]", "local change detected: web/src/App.tsx, refreshing diff"} {
		if !strings.Contains(got, want) {
			t.Fatalf("printReload() missing %q in %q", want, got)
		}
	}
}

func TestReloadLoggerCoalescesBursts(t *testing.T) {
	var out bytes.Buffer
	reload := newReloadLogger(&out, false)
	now := time.Date(2026, 5, 23, 14, 15, 16, 0, time.Local)

	reload(now, []string{"one.go"})
	reload(now.Add(100*time.Millisecond), []string{"two.go"})
	reload(now.Add(600*time.Millisecond), []string{"three.go"})

	if got := strings.Count(out.String(), "refreshing diff"); got != 2 {
		t.Fatalf("reload log count = %d, want 2:\n%s", got, out.String())
	}
}

func TestReloadMessageSummarizesMultiplePaths(t *testing.T) {
	got := reloadMessage([]string{"a.go", "b.go", "c.go"}, terminalColors{}, false)
	want := "local changes detected: a.go (+2 more), refreshing diff"
	if got != want {
		t.Fatalf("reloadMessage() = %q, want %q", got, want)
	}
}
