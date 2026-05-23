package main

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"syscall"
)

type listenFallback struct {
	Requested string
	Actual    string
}

type prTarget struct {
	Path string
	Host string
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

func listenWithPortFallback(addr string) (net.Listener, *listenFallback, error) {
	ln, err := net.Listen("tcp", addr)
	if err == nil {
		return ln, nil, nil
	}
	if !isAddrInUse(err) {
		return nil, nil, err
	}
	fallbackAddr, ok := randomPortAddr(addr)
	if !ok {
		return nil, nil, err
	}
	ln, fallbackErr := net.Listen("tcp", fallbackAddr)
	if fallbackErr != nil {
		return nil, nil, fmt.Errorf("%w; fallback to a random port failed: %v", err, fallbackErr)
	}
	return ln, &listenFallback{Requested: addr, Actual: ln.Addr().String()}, nil
}

func randomPortAddr(addr string) (string, bool) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil || port == "0" {
		return "", false
	}
	return net.JoinHostPort(host, "0"), true
}

func isAddrInUse(err error) bool {
	if errors.Is(err, syscall.EADDRINUSE) {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "address already in use") ||
		strings.Contains(message, "only one usage of each socket address")
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
	target, err := prTargetFromArgs(args)
	if err != nil {
		return "", err
	}
	return target.Path, nil
}

func prTargetFromArgs(args []string) (prTarget, error) {
	if len(args) != 1 || strings.TrimSpace(args[0]) == "" {
		return prTarget{}, fmt.Errorf("expected one GitHub PR target")
	}
	target := strings.TrimSpace(args[0])
	host := ""
	lowerTarget := strings.ToLower(target)
	if strings.HasPrefix(lowerTarget, "http://") || strings.HasPrefix(lowerTarget, "https://") {
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			return prTarget{}, err
		}
		host = strings.ToLower(req.URL.Hostname())
		if host == "" {
			return prTarget{}, fmt.Errorf("target URL must include a host")
		}
		target = req.URL.Path
	}
	if !strings.HasPrefix(target, "/") {
		target = "/" + target
	}
	parts := strings.Split(strings.Trim(target, "/"), "/")
	if len(parts) >= 4 && parts[2] == "pull" && parts[3] != "" {
		if len(parts) == 4 || isPullRequestSubpage(parts[4:]) {
			return prTarget{Path: "/" + strings.Join(parts[:4], "/"), Host: host}, nil
		}
	}
	return prTarget{}, fmt.Errorf("target must be a GitHub PR URL or /org/repo/pull/123")
}

func resolvePRTargetFromArgs(args []string, dir string) (prTarget, error) {
	target, ok := prNumberFromArgs(args)
	if !ok {
		return prTargetFromArgs(args)
	}

	remote, err := gitRemoteURL(dir, "origin")
	if err != nil {
		return prTarget{}, fmt.Errorf("resolve current repository for PR #%s: %w", target, err)
	}
	repo, err := repoFromRemoteURL(remote)
	if err != nil {
		return prTarget{}, fmt.Errorf("resolve current repository for PR #%s: %w", target, err)
	}
	return prTarget{
		Path: fmt.Sprintf("/%s/%s/pull/%s", repo.Owner, repo.Name, target),
		Host: repo.Host,
	}, nil
}

func prNumberFromArgs(args []string) (string, bool) {
	if len(args) != 1 {
		return "", false
	}
	target := strings.TrimSpace(args[0])
	n, err := strconv.Atoi(target)
	if err != nil || n <= 0 {
		return "", false
	}
	return target, true
}

type remoteRepo struct {
	Host  string
	Owner string
	Name  string
}

func repoFromRemoteURL(remote string) (remoteRepo, error) {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return remoteRepo{}, fmt.Errorf("origin remote URL is empty")
	}
	var host, path string
	if strings.Contains(remote, "://") {
		u, err := url.Parse(remote)
		if err != nil {
			return remoteRepo{}, err
		}
		host = u.Hostname()
		if host == "" {
			return remoteRepo{}, fmt.Errorf("origin remote URL must include a host")
		}
		path = u.Path
	} else {
		userHost, scpPath, ok := strings.Cut(remote, ":")
		if !ok || strings.Contains(userHost, "/") {
			return remoteRepo{}, fmt.Errorf("origin remote URL must be an absolute URL or SCP-style remote")
		}
		host = userHost
		if _, after, ok := strings.Cut(userHost, "@"); ok {
			host = after
		}
		path = scpPath
	}
	host = strings.ToLower(host)
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 2 {
		return remoteRepo{}, fmt.Errorf("origin remote URL must include owner and repository")
	}
	name := strings.TrimSuffix(parts[1], ".git")
	if parts[0] == "" || name == "" {
		return remoteRepo{}, fmt.Errorf("origin remote URL must include owner and repository")
	}
	return remoteRepo{Host: host, Owner: parts[0], Name: name}, nil
}

func isPullRequestSubpage(parts []string) bool {
	if len(parts) != 1 {
		return false
	}
	switch parts[0] {
	case "checks", "commits", "files", "reviews":
		return true
	default:
		return false
	}
}
