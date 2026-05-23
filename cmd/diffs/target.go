package main

import (
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
)

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
	if len(args) != 1 || strings.TrimSpace(args[0]) == "" {
		return "", fmt.Errorf("expected one GitHub PR target")
	}
	target := strings.TrimSpace(args[0])
	if strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") {
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			return "", err
		}
		target = req.URL.Path
	}
	if !strings.HasPrefix(target, "/") {
		target = "/" + target
	}
	parts := strings.Split(strings.Trim(target, "/"), "/")
	if len(parts) == 4 && parts[2] == "pull" && parts[3] != "" {
		return "/" + strings.Join(parts, "/"), nil
	}
	return "", fmt.Errorf("target must be a GitHub PR URL or /org/repo/pull/123")
}
