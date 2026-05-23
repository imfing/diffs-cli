package main

import (
	"errors"
	"fmt"
	"net"
	"net/http"
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
	if strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") {
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			return prTarget{}, err
		}
		host = req.URL.Hostname()
		target = req.URL.Path
	}
	if !strings.HasPrefix(target, "/") {
		target = "/" + target
	}
	parts := strings.Split(strings.Trim(target, "/"), "/")
	if len(parts) == 4 && parts[2] == "pull" && parts[3] != "" {
		return prTarget{Path: "/" + strings.Join(parts, "/"), Host: host}, nil
	}
	return prTarget{}, fmt.Errorf("target must be a GitHub PR URL or /org/repo/pull/123")
}
