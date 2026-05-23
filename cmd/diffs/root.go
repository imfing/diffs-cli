package main

import (
	"os"
	"strings"
	"time"

	"github.com/imfing/diffs-cli/internal/server"
	"github.com/spf13/cobra"
)

const (
	defaultHost = "127.0.0.1"
	defaultPort = 3433
	defaultDir  = "."
)

type cliOptions struct {
	host   string
	port   int
	ghHost string
	dir    string
	noOpen bool
}

func newRootCommand(started time.Time) *cobra.Command {
	opts := &cliOptions{
		host:   defaultHost,
		port:   defaultPort,
		ghHost: defaultGithubHost(),
		dir:    defaultDir,
	}
	root := &cobra.Command{
		Use:           "diffs [flags]",
		Short:         "Review local diffs and GitHub pull requests in a browser",
		SilenceErrors: true,
		SilenceUsage:  true,
		Args:          cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runServerTarget(cmd, opts, "/local", started)
		},
	}
	root.PersistentFlags().StringVar(&opts.dir, "dir", opts.dir, "repository directory for local diff and comments")
	addServeFlags(root, opts, false)
	root.AddCommand(
		newPRCommand(opts, started),
		newCommentsCommand(opts),
		newVersionCommand(),
	)
	return root
}

func newPRCommand(opts *cliOptions, started time.Time) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "pr [number|github-pr-url|/org/repo/pull/123]",
		Short: "Review a GitHub pull request",
		Long:  "Review a GitHub pull request. With no argument, resolves the PR associated with the current branch via `gh pr view`.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			target, err := resolvePRTargetFromArgs(args, opts.dir)
			if err != nil {
				return err
			}
			return runServerTarget(cmd, opts.withResolvedGitHubHost(cmd, target.Host), target.Path, started)
		},
	}
	addServeFlags(cmd, opts, true)
	return cmd
}

func addServeFlags(cmd *cobra.Command, opts *cliOptions, includeGHHost bool) {
	cmd.Flags().StringVar(&opts.host, "host", opts.host, "host to serve the review UI on")
	cmd.Flags().IntVar(&opts.port, "port", opts.port, "port to serve the review UI on")
	if includeGHHost {
		cmd.Flags().StringVar(&opts.ghHost, "gh-host", opts.ghHost, "GitHub host used by gh api")
	}
	cmd.Flags().BoolVar(&opts.noOpen, "no-open", false, "do not open the browser automatically")
}

func defaultGithubHost() string {
	if host := strings.TrimSpace(os.Getenv("GH_HOST")); host != "" {
		return host
	}
	return server.DefaultGitHubHost
}

func (opts *cliOptions) withResolvedGitHubHost(cmd *cobra.Command, targetHost string) *cliOptions {
	next := *opts
	if strings.TrimSpace(targetHost) != "" && !cmd.Flags().Changed("gh-host") {
		next.ghHost = targetHost
	}
	return &next
}
