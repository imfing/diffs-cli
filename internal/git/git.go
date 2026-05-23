package git

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const DefaultTimeout = 2 * time.Second

var ErrNotRepository = errors.New("not a git repository")

func Command(ctx context.Context, dir string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	return cmd
}

func Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	return Command(ctx, dir, args...).Output()
}

func OK(ctx context.Context, dir string, args ...string) bool {
	return Command(ctx, dir, args...).Run() == nil
}

func Root(ctx context.Context, cwd string) (string, error) {
	if cwd == "" {
		cwd = "."
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return "", err
	}
	root, err := Run(ctx, abs, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", ErrNotRepository
	}
	return strings.TrimSpace(string(root)), nil
}

func Branch(ctx context.Context, dir string) string {
	branch, err := Run(ctx, dir, "branch", "--show-current")
	if err == nil && strings.TrimSpace(string(branch)) != "" {
		return strings.TrimSpace(string(branch))
	}
	commit, err := Run(ctx, dir, "rev-parse", "--short", "HEAD")
	if err == nil {
		return strings.TrimSpace(string(commit))
	}
	return ""
}
