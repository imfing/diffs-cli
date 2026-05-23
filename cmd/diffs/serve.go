package main

import (
	"fmt"
	"net/http"
	"path/filepath"
	"time"

	"github.com/imfing/diffs-cli/internal/appconfig"
	"github.com/imfing/diffs-cli/internal/server"
	"github.com/spf13/cobra"
)

func runServerTarget(cmd *cobra.Command, opts *cliOptions, targetPath string, started time.Time) error {
	if started.IsZero() {
		started = time.Now()
	}
	out := cmd.OutOrStdout()
	errOut := cmd.ErrOrStderr()

	displayCWD, err := filepath.Abs(opts.dir)
	if err != nil {
		return err
	}
	if targetPath == "/local" {
		root, err := gitRoot(displayCWD)
		if err != nil {
			printLocalGitHelp(errOut, displayCWD, colorEnabled(errOut))
			_ = cmd.Help()
			return quietError{err: err}
		}
		displayCWD = root
		opts.dir = root
	}
	appCfg, _, err := appconfig.LoadDefault()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	cfg := server.Config{
		CWD:        opts.dir,
		GitHubHost: opts.githubHost,
		UI:         appCfg.UI,
		Watch:      targetPath == "/local",
	}
	if targetPath == "/local" {
		reload := newReloadLogger(out, colorEnabled(out))
		cfg.OnChange = func(files []server.ChangedFile) {
			reload(time.Now(), files)
		}
	}
	handler, err := server.New(cfg)
	if err != nil {
		return err
	}

	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	listenAddr, err := listenAddrFromOptions(opts.host, opts.port)
	if err != nil {
		return err
	}
	ln, fallback, err := listenWithPortFallback(listenAddr)
	if err != nil {
		return err
	}
	url := browserURL(ln.Addr(), targetPath)
	if fallback != nil {
		printPortFallback(out, fallback.Requested, fallback.Actual, colorEnabled(out))
	}
	printStartup(out, startupInfo{
		URL:      url,
		Target:   targetLabel(targetPath, displayCWD),
		CWD:      displayCWD,
		Watching: targetPath == "/local",
		Elapsed:  time.Since(started),
	}, colorEnabled(out))

	if !opts.noOpen {
		if err := openBrowser(url); err != nil {
			_, _ = fmt.Fprintf(errOut, "warning: could not open browser: %v\n", err)
		}
	}

	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
