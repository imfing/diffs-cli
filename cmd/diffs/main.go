package main

import (
	"errors"
	"fmt"
	"os"
	"time"
)

func main() {
	if err := newRootCommand(time.Now()).Execute(); err != nil {
		var quiet quietError
		if !errors.As(err, &quiet) {
			_, _ = fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
