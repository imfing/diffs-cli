package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/imfing/diffs-cli/internal/server"
)

func main() {
	started := time.Now()
	var (
		host       = flag.String("host", "127.0.0.1", "host to serve the review UI on")
		port       = flag.Int("port", 3433, "port to serve the review UI on")
		githubHost = flag.String("github-host", defaultGithubHost(), "GitHub host used by gh api")
		cwd        = flag.String("cwd", ".", "repository directory for the local diff view")
		noOpen     = flag.Bool("no-open", false, "do not open the browser automatically")
	)
	flag.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "Usage: diffs [flags] [github-pr-url|/org/repo/pull/123|local]\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	targetPath, err := targetPathFromArgs(flag.Args())
	if err != nil {
		log.Fatal(err)
	}
	displayCWD, err := filepath.Abs(*cwd)
	if err != nil {
		log.Fatal(err)
	}

	cfg := server.Config{
		CWD:        *cwd,
		GitHubHost: *githubHost,
	}
	if targetPath == "/local" {
		reload := newReloadLogger(os.Stdout, colorEnabled())
		cfg.OnChange = func(paths []string) {
			reload(time.Now(), paths)
		}
	}
	handler, err := server.New(cfg)
	if err != nil {
		log.Fatal(err)
	}

	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	listenAddr, err := listenAddrFromOptions(*host, *port)
	if err != nil {
		log.Fatal(err)
	}
	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		log.Fatal(err)
	}
	url := browserURL(ln.Addr(), targetPath)
	printStartup(os.Stdout, startupInfo{
		URL:      url,
		Target:   targetLabel(targetPath, displayCWD),
		CWD:      displayCWD,
		Watching: targetPath == "/local",
		Elapsed:  time.Since(started),
	}, colorEnabled())

	if !*noOpen {
		if err := openBrowser(url); err != nil {
			fmt.Fprintf(os.Stderr, "warning: could not open browser: %v\n", err)
		}
	}

	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func defaultGithubHost() string {
	if host := strings.TrimSpace(os.Getenv("GH_HOST")); host != "" {
		return host
	}
	return "github.com"
}

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
	fmt.Fprintf(w, "\n  %s%sDIFFS%s %sready in %s%s\n\n", c.bold, c.green, c.reset, c.dim, formatReadyDuration(info.Elapsed), c.reset)
	fmt.Fprintf(w, "  %sLocal:%s   %s%s%s\n", c.green, c.reset, c.cyan, info.URL, c.reset)
	fmt.Fprintf(w, "  %sTarget:%s  %s\n", c.green, c.reset, info.Target)
	if info.Watching {
		fmt.Fprintf(w, "  %sWatch:%s   %s\n", c.green, c.reset, info.CWD)
	}
	fmt.Fprintf(w, "\n  %sPress Ctrl+C to stop.%s\n\n", c.dim, c.reset)
}

func printReload(w io.Writer, now time.Time, paths []string, color bool) {
	c := colors(color)
	fmt.Fprintf(w, "  %s%s%s %s[diffs]%s %s\n", c.dim, now.Format("15:04:05"), c.reset, c.yellow, c.reset, reloadMessage(paths, c, color))
}

func reloadMessage(paths []string, c terminalColors, color bool) string {
	if len(paths) == 0 {
		return "local changes detected, refreshing diff"
	}

	path := paths[0]
	if color {
		path = c.cyan + path + c.reset
	}
	if len(paths) == 1 {
		return fmt.Sprintf("local change detected: %s, refreshing diff", path)
	}
	return fmt.Sprintf("local changes detected: %s (+%d more), refreshing diff", path, len(paths)-1)
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

func targetLabel(targetPath, cwd string) string {
	if targetPath == "/local" {
		if branch := gitBranch(cwd); branch != "" {
			return branch
		}
		return "local repository"
	}
	parts := strings.Split(strings.Trim(targetPath, "/"), "/")
	if len(parts) == 4 && parts[2] == "pull" {
		return fmt.Sprintf("GitHub PR %s/%s#%s", parts[0], parts[1], parts[3])
	}
	return targetPath
}

func gitBranch(cwd string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	branch, err := gitOutput(ctx, cwd, "branch", "--show-current")
	if err == nil && strings.TrimSpace(branch) != "" {
		return strings.TrimSpace(branch)
	}

	commit, err := gitOutput(ctx, cwd, "rev-parse", "--short", "HEAD")
	if err == nil {
		return strings.TrimSpace(commit)
	}
	return ""
}

func gitOutput(ctx context.Context, cwd string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func listenAddrFromOptions(host string, port int) (string, error) {
	if port < 0 || port > 65535 {
		return "", fmt.Errorf("port must be between 0 and 65535")
	}
	host = strings.TrimSpace(host)
	if host == "" {
		host = "127.0.0.1"
	}
	return normalizeListenAddr(net.JoinHostPort(host, strconv.Itoa(port))), nil
}

func normalizeListenAddr(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	if host == "localhost" {
		return net.JoinHostPort("127.0.0.1", port)
	}
	return addr
}

func browserURL(addr net.Addr, targetPath string) string {
	host, port, err := net.SplitHostPort(addr.String())
	if err != nil {
		return "http://" + addr.String() + targetPath
	}
	if host == "" || host == "::" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port) + targetPath
}

func targetPathFromArgs(args []string) (string, error) {
	if len(args) == 0 || args[0] == "" || args[0] == "local" {
		return "/local", nil
	}
	if len(args) > 1 {
		return "", fmt.Errorf("expected at most one target argument")
	}
	target := strings.TrimSpace(args[0])
	if strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") {
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			return "", err
		}
		target = req.URL.Path
	}
	if !strings.HasPrefix(target, "/") {
		target = "/" + target
	}
	parts := strings.Split(strings.Trim(target, "/"), "/")
	if len(parts) == 4 && parts[2] == "pull" && parts[3] != "" {
		return "/" + strings.Join(parts, "/"), nil
	}
	return "", fmt.Errorf("target must be local, a GitHub PR URL, or /org/repo/pull/123")
}

func openBrowser(url string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.CommandContext(ctx, "open", url)
	case "windows":
		cmd = exec.CommandContext(ctx, "rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.CommandContext(ctx, "xdg-open", url)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg != "" {
			return fmt.Errorf("%w: %s", err, msg)
		}
		return err
	}
	return nil
}
