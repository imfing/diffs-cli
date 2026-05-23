package main

import (
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

type cliOptions struct {
	host       string
	port       int
	githubHost string
	dir        string
	noOpen     bool
}

func newRootCommand(started time.Time) *cobra.Command {
	opts := &cliOptions{
		host:       "127.0.0.1",
		port:       3433,
		githubHost: defaultGithubHost(),
		dir:        ".",
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
		newLocalCommand(opts, started),
		newPRCommand(opts, started),
		newCommentsCommand(opts),
	)
	return root
}

func newLocalCommand(opts *cliOptions, started time.Time) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "local",
		Short: "Review local working tree changes",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runServerTarget(cmd, opts, "/local", started)
		},
	}
	addServeFlags(cmd, opts, false)
	return cmd
}

func newPRCommand(opts *cliOptions, started time.Time) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "pr [github-pr-url|/org/repo/pull/123]",
		Short: "Review a GitHub pull request",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			targetPath, err := targetPathFromArgs(args)
			if err != nil {
				return err
			}
			return runServerTarget(cmd, opts, targetPath, started)
		},
	}
	addServeFlags(cmd, opts, true)
	return cmd
}

func addServeFlags(cmd *cobra.Command, opts *cliOptions, includeGitHubHost bool) {
	cmd.Flags().StringVar(&opts.host, "host", opts.host, "host to serve the review UI on")
	cmd.Flags().IntVar(&opts.port, "port", opts.port, "port to serve the review UI on")
	if includeGitHubHost {
		cmd.Flags().StringVar(&opts.githubHost, "github-host", opts.githubHost, "GitHub host used by gh api")
	}
	cmd.Flags().BoolVar(&opts.noOpen, "no-open", false, "do not open the browser automatically")
}

func defaultGithubHost() string {
	if host := strings.TrimSpace(os.Getenv("GH_HOST")); host != "" {
		return host
	}
	return "github.com"
}
