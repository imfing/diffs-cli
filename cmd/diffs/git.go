package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	gitcmd "github.com/imfing/diffs-cli/internal/git"
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
	ctx, cancel := context.WithTimeout(context.Background(), gitcmd.DefaultTimeout)
	defer cancel()

	root, err := gitcmd.Root(ctx, cwd)
	if err != nil {
		return "", fmt.Errorf("%w: %s", errNotGitRepository, cwd)
	}
	return root, nil
}

func gitBranch(cwd string) string {
	ctx, cancel := context.WithTimeout(context.Background(), gitcmd.DefaultTimeout)
	defer cancel()
	return gitcmd.Branch(ctx, cwd)
}
