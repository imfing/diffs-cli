package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

func main() {
	if err := executeRootCommand(newRootCommand(time.Now())); err != nil {
		var quiet quietError
		if !errors.As(err, &quiet) {
			_, _ = fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}

func executeRootCommand(cmd *cobra.Command) error {
	err := cmd.Execute()
	if err == nil || !isUnknownCommandError(err) {
		return err
	}

	errOut := cmd.ErrOrStderr()
	_, _ = fmt.Fprintln(errOut, err)
	_, _ = fmt.Fprintln(errOut)
	cmd.SetOut(errOut)
	_ = cmd.Help()
	return quietError{err: err}
}

func isUnknownCommandError(err error) bool {
	return strings.HasPrefix(err.Error(), "unknown command ")
}
