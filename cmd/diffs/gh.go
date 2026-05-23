package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const defaultGHTimeout = 10 * time.Second

var runGHPRView = func(ctx context.Context, dir string) (string, error) {
	return runGH(ctx, dir, "pr", "view", "--json", "url", "-q", ".url")
}

var runGHPRBaseRef = func(ctx context.Context, dir string) (string, error) {
	return runGH(ctx, dir, "pr", "view", "--json", "baseRefName", "-q", ".baseRefName")
}

var runGHRepoDefaultBranch = func(ctx context.Context, dir string) (string, error) {
	return runGH(ctx, dir, "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name")
}

func runGH(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "gh", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && len(exitErr.Stderr) > 0 {
			return "", errors.New(strings.TrimSpace(string(exitErr.Stderr)))
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func currentBranchPRURL(dir string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultGHTimeout)
	defer cancel()
	url, err := runGHPRView(ctx, dir)
	if err != nil {
		return "", fmt.Errorf("resolve PR for current branch: %w\nhint: open a PR for this branch, or pass `diffs pr <number>`", err)
	}
	if url == "" {
		return "", errors.New("no pull request found for the current branch")
	}
	return url, nil
}
