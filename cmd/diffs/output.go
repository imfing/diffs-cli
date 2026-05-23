package main

import (
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"github.com/imfing/diffs-cli/internal/server"
)

const reloadDebounce = 500 * time.Millisecond

type startupInfo struct {
	URL      string
	Target   string
	CWD      string
	Watching bool
	Elapsed  time.Duration
}

type terminalColors struct {
	reset   string
	bold    string
	dim     string
	green   string
	cyan    string
	yellow  string
	red     string
	magenta string
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
		reset:   "\x1b[0m",
		bold:    "\x1b[1m",
		dim:     "\x1b[2m",
		green:   "\x1b[32m",
		cyan:    "\x1b[36m",
		yellow:  "\x1b[33m",
		red:     "\x1b[31m",
		magenta: "\x1b[35m",
	}
}

func printStartup(w io.Writer, info startupInfo, color bool) {
	c := colors(color)
	_, _ = fmt.Fprintln(w)
	printLogLine(w, c, "diffs", fmt.Sprintf("ready in %s", formatReadyDuration(info.Elapsed)))
	printLogLine(w, c, "serve", colorize(info.URL, c.cyan, c.reset))
	printLogLine(w, c, "target", info.Target)
	if info.Watching {
		printLogLine(w, c, "watch", info.CWD)
	}
	printLogLine(w, c, "stop", colorize("Ctrl+C", c.dim, c.reset))
	_, _ = fmt.Fprintln(w)
}

func printPortFallback(w io.Writer, requested, actual string, color bool) {
	c := colors(color)
	_, _ = fmt.Fprintln(w)
	printLogLineColor(w, c, "warn", fmt.Sprintf("%s in use; using %s", requested, actual), c.yellow)
}

func printReload(w io.Writer, _ time.Time, files []server.ChangedFile, color bool) {
	c := colors(color)
	label, message := reloadLine(files, c, color)
	printLogLineColor(w, c, label, message, reloadLabelColor(label, c))
}

func printLocalGitHelp(w io.Writer, dir string, color bool) {
	c := colors(color)
	_, _ = fmt.Fprintln(w)
	printLogLine(w, c, "error", fmt.Sprintf("not a git repository: %s", dir))
	printLogLine(w, c, "hint", "run from a git repository")
	printLogLine(w, c, "hint", "or pass --dir /path/to/repo")
	printLogLine(w, c, "hint", "or use diffs pr /org/repo/pull/123")
	_, _ = fmt.Fprintln(w)
}

func reloadLine(files []server.ChangedFile, c terminalColors, color bool) (string, string) {
	if len(files) == 0 {
		return "change", "local changes"
	}

	action := files[0].Action
	label := string(action)
	if action == "" {
		label = "change"
	}
	path := files[0].Path
	if color {
		path = c.cyan + path + c.reset
	}
	if len(files) == 1 {
		return label, path
	}
	return label, fmt.Sprintf("%s (+%d more)", path, len(files)-1)
}

func reloadLabelColor(label string, c terminalColors) string {
	switch label {
	case string(server.ChangeAdded):
		return c.green
	case string(server.ChangeModified):
		return c.yellow
	case string(server.ChangeDeleted):
		return c.red
	case string(server.ChangeRenamed):
		return c.magenta
	default:
		return c.green
	}
}

func newReloadLogger(w io.Writer, color bool) func(time.Time, []server.ChangedFile) {
	var mu sync.Mutex
	var last time.Time
	return func(now time.Time, files []server.ChangedFile) {
		mu.Lock()
		defer mu.Unlock()
		if !last.IsZero() && now.Sub(last) < reloadDebounce {
			return
		}
		last = now
		printReload(w, now, files, color)
	}
}

func formatReadyDuration(d time.Duration) string {
	ms := d.Round(time.Millisecond).Milliseconds()
	if ms < 1 {
		ms = 1
	}
	return fmt.Sprintf("%d ms", ms)
}

func printLogLineColor(w io.Writer, c terminalColors, label string, message string, color string) {
	if color == "" {
		color = c.green
	}
	_, _ = fmt.Fprintf(w, "  %s%-8s%s %s\n", color, label, c.reset, message)
}

func printLogLine(w io.Writer, c terminalColors, label string, message string) {
	printLogLineColor(w, c, label, message, "")
}

func colorize(text, color, reset string) string {
	if color == "" {
		return text
	}
	return color + text + reset
}
