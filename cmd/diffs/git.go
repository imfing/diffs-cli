package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
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
	if strings.HasPrefix(targetPath, "/branch") {
		base := branchBaseFromTargetPath(targetPath)
		head := gitBranch(cwd)
		if head == "" {
			head = "HEAD"
		}
		if base == "" {
			return fmt.Sprintf("%s branch diff", head)
		}
		return fmt.Sprintf("%s -> %s", head, base)
	}
	parts := strings.Split(strings.Trim(targetPath, "/"), "/")
	if len(parts) == 4 && parts[2] == "pull" {
		return fmt.Sprintf("GitHub PR %s/%s#%s", parts[0], parts[1], parts[3])
	}
	return targetPath
}

func branchBaseFromTargetPath(targetPath string) string {
	queryStart := strings.IndexByte(targetPath, '?')
	if queryStart < 0 {
		return ""
	}
	values, err := url.ParseQuery(targetPath[queryStart+1:])
	if err != nil {
		return ""
	}
	return values.Get("base")
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

func gitRefExists(cwd, ref string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), gitcmd.DefaultTimeout)
	defer cancel()
	return gitcmd.OK(ctx, cwd, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
}

func gitRemoteURL(cwd, name string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitcmd.DefaultTimeout)
	defer cancel()
	out, err := gitcmd.Run(ctx, cwd, "remote", "get-url", name)
	if err != nil {
		return "", fmt.Errorf("get git remote %q URL: %w", name, err)
	}
	return strings.TrimSpace(string(out)), nil
}
