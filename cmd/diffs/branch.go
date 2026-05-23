package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

func newBranchCommand(opts *cliOptions, started time.Time) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "branch [base]",
		Short: "Review commits on the current branch against a base",
		Long:  "Compare HEAD against a base ref (three-dot). With no argument, infers the base from the branch's PR, repo default, or main/master.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			displayCWD, err := filepath.Abs(opts.dir)
			if err != nil {
				return err
			}
			if _, err := gitRoot(displayCWD); err != nil {
				errOut := cmd.ErrOrStderr()
				printLocalGitHelp(errOut, displayCWD, colorEnabled(errOut))
				_ = cmd.Help()
				return quietError{err: err}
			}
			base, err := resolveBranchBase(args, opts.dir)
			if err != nil {
				return err
			}
			target := "/branch?base=" + url.QueryEscape(base)
			return runServerTarget(cmd, opts, target, started)
		},
	}
	addServeFlags(cmd, opts, false)
	return cmd
}

func resolveBranchBase(args []string, dir string) (string, error) {
	if len(args) == 1 {
		base := strings.TrimSpace(args[0])
		if base == "" {
			return "", errors.New("base ref must not be empty")
		}
		return base, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), defaultGHTimeout)
	defer cancel()

	if base, err := runGHPRBaseRef(ctx, dir); err == nil && base != "" {
		if ref, ok := resolveLocalRef(dir, base); ok {
			return ref, nil
		}
	}
	if base, err := runGHRepoDefaultBranch(ctx, dir); err == nil && base != "" {
		if ref, ok := resolveLocalRef(dir, base); ok {
			return ref, nil
		}
	}
	for _, candidate := range []string{"main", "master"} {
		if ref, ok := resolveLocalRef(dir, candidate); ok {
			return ref, nil
		}
	}
	return "", fmt.Errorf("could not infer base ref; pass one explicitly, e.g. `diffs branch main`")
}

// resolveLocalRef returns ref if it resolves to a commit locally, otherwise
// tries origin/<ref>. Inferred bases (PR base, default branch) may name
// branches that exist only as a remote-tracking ref in fresh clones.
func resolveLocalRef(dir, ref string) (string, bool) {
	if gitRefExists(dir, ref) {
		return ref, true
	}
	if candidate := "origin/" + ref; gitRefExists(dir, candidate) {
		return candidate, true
	}
	return "", false
}
