package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

var errNotGitRepository = errors.New("not a git repository")

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

func gitRoot(cwd string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	root, err := gitOutput(ctx, cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", fmt.Errorf("%w: %s", errNotGitRepository, cwd)
	}
	return strings.TrimSpace(root), nil
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
