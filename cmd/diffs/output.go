package main

import (
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

type startupInfo struct {
	URL      string
	Target   string
	CWD      string
	Watching bool
	Elapsed  time.Duration
}

type terminalColors struct {
	reset  string
	bold   string
	dim    string
	green  string
	cyan   string
	yellow string
}

type quietError struct {
	err error
}

func (e quietError) Error() string {
	return e.err.Error()
}

func (e quietError) Unwrap() error {
	return e.err
}

func colorEnabled() bool {
	return os.Getenv("NO_COLOR") == "" && os.Getenv("TERM") != "dumb"
}

func colors(enabled bool) terminalColors {
	if !enabled {
		return terminalColors{}
	}
	return terminalColors{
		reset:  "\x1b[0m",
		bold:   "\x1b[1m",
		dim:    "\x1b[2m",
		green:  "\x1b[32m",
		cyan:   "\x1b[36m",
		yellow: "\x1b[33m",
	}
}

func printStartup(w io.Writer, info startupInfo, color bool) {
	c := colors(color)
	fmt.Fprintln(w)
	printLogLine(w, c, "diffs", fmt.Sprintf("ready in %s", formatReadyDuration(info.Elapsed)))
	printLogLine(w, c, "serve", colorize(info.URL, c.cyan, c.reset))
	printLogLine(w, c, "target", info.Target)
	if info.Watching {
		printLogLine(w, c, "watch", info.CWD)
	}
	printLogLine(w, c, "stop", colorize("Ctrl+C", c.dim, c.reset))
	fmt.Fprintln(w)
}

func printReload(w io.Writer, _ time.Time, paths []string, color bool) {
	c := colors(color)
	printLogLine(w, c, "change", reloadMessage(paths, c, color))
}

func printLocalGitHelp(w io.Writer, dir string, color bool) {
	c := colors(color)
	fmt.Fprintln(w)
	printLogLine(w, c, "error", fmt.Sprintf("not a git repository: %s", dir))
	printLogLine(w, c, "hint", "run from a git repository")
	printLogLine(w, c, "hint", "or pass --dir /path/to/repo")
	printLogLine(w, c, "hint", "or use diffs pr /org/repo/pull/123")
	fmt.Fprintln(w)
}

func reloadMessage(paths []string, c terminalColors, color bool) string {
	if len(paths) == 0 {
		return "local changes"
	}

	path := paths[0]
	if color {
		path = c.cyan + path + c.reset
	}
	if len(paths) == 1 {
		return path
	}
	return fmt.Sprintf("%s (+%d more)", path, len(paths)-1)
}

func newReloadLogger(w io.Writer, color bool) func(time.Time, []string) {
	var mu sync.Mutex
	var last time.Time
	return func(now time.Time, paths []string) {
		mu.Lock()
		defer mu.Unlock()
		if !last.IsZero() && now.Sub(last) < 500*time.Millisecond {
			return
		}
		last = now
		printReload(w, now, paths, color)
	}
}

func formatReadyDuration(d time.Duration) string {
	ms := d.Round(time.Millisecond).Milliseconds()
	if ms < 1 {
		ms = 1
	}
	return fmt.Sprintf("%d ms", ms)
}

func printLogLine(w io.Writer, c terminalColors, label string, message string) {
	fmt.Fprintf(w, "  %s%-7s%s %s\n", c.green, label, c.reset, message)
}

func colorize(text, color, reset string) string {
	if color == "" {
		return text
	}
	return color + text + reset
}
