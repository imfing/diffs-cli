package main

import (
	"fmt"
	"io"
	"strings"
	"text/tabwriter"

	"github.com/imfing/diffs-cli/internal/comments"
	"github.com/spf13/cobra"
)

type commentsOptions struct {
	json bool
}

func newCommentsCommand(opts *cliOptions) *cobra.Command {
	commentOpts := &commentsOptions{}
	cmd := &cobra.Command{
		Use:   "comments",
		Short: "Manage local review comments",
	}
	cmd.PersistentFlags().BoolVar(&commentOpts.json, "json", false, "write JSON output")
	cmd.AddCommand(
		newCommentsListCommand(opts, commentOpts),
		newCommentsAddCommand(opts, commentOpts),
		newCommentsReplyCommand(opts, commentOpts),
		newCommentsResolveCommand(opts, commentOpts),
		newCommentsReopenCommand(opts, commentOpts),
	)
	return cmd
}

func newCommentsListCommand(opts *cliOptions, commentOpts *commentsOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List local comment threads for the current branch",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			store, err := comments.NewStore(opts.dir)
			if err != nil {
				return err
			}
			threads, err := store.List(cmd.Context())
			if err != nil {
				return err
			}
			if commentOpts.json {
				return writeJSONCLI(cmd.OutOrStdout(), map[string]any{"threads": threads})
			}
			printThreads(cmd.OutOrStdout(), threads)
			return nil
		},
	}
}

func newCommentsAddCommand(opts *cliOptions, commentOpts *commentsOptions) *cobra.Command {
	var input comments.AddThreadInput
	cmd := &cobra.Command{
		Use:   "add --file PATH --line LINE [--end-line LINE] --body BODY",
		Short: "Create a local comment thread",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			body, err := bodyFromFlag(cmd, input.Body)
			if err != nil {
				return err
			}
			input.Body = body
			store, err := comments.NewStore(opts.dir)
			if err != nil {
				return err
			}
			thread, err := store.AddThread(cmd.Context(), input)
			if err != nil {
				return err
			}
			return printThreadResult(cmd.OutOrStdout(), thread, commentOpts.json)
		},
	}
	cmd.Flags().StringVar(&input.Path, "file", "", "repository-relative file path")
	cmd.Flags().IntVar(&input.Line, "line", 0, "line number")
	cmd.Flags().StringVar(&input.Side, "side", comments.DefaultSide, "diff side: additions or deletions")
	cmd.Flags().IntVar(&input.EndLine, "end-line", 0, "end line number for a multi-line comment")
	cmd.Flags().StringVar(&input.EndSide, "end-side", "", "end diff side for a multi-line comment: additions or deletions")
	cmd.Flags().StringVar(&input.Body, "body", "", "comment body, or - to read stdin")
	cmd.Flags().StringVar(&input.Author, "author", comments.DefaultAuthor, "comment author")
	_ = cmd.MarkFlagRequired("file")
	_ = cmd.MarkFlagRequired("line")
	_ = cmd.MarkFlagRequired("body")
	return cmd
}

func newCommentsReplyCommand(opts *cliOptions, commentOpts *commentsOptions) *cobra.Command {
	var input comments.AddReplyInput
	cmd := &cobra.Command{
		Use:   "reply THREAD_ID --body BODY",
		Short: "Reply to a local comment thread",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body, err := bodyFromFlag(cmd, input.Body)
			if err != nil {
				return err
			}
			input.Body = body
			store, err := comments.NewStore(opts.dir)
			if err != nil {
				return err
			}
			thread, err := store.AddReply(cmd.Context(), args[0], input)
			if err != nil {
				return err
			}
			return printThreadResult(cmd.OutOrStdout(), thread, commentOpts.json)
		},
	}
	cmd.Flags().StringVar(&input.Body, "body", "", "reply body, or - to read stdin")
	cmd.Flags().StringVar(&input.Author, "author", comments.DefaultAuthor, "reply author")
	_ = cmd.MarkFlagRequired("body")
	return cmd
}

func newCommentsResolveCommand(opts *cliOptions, commentOpts *commentsOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "resolve THREAD_ID",
		Short: "Resolve a local comment thread",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := comments.NewStore(opts.dir)
			if err != nil {
				return err
			}
			thread, err := store.Resolve(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			return printThreadResult(cmd.OutOrStdout(), thread, commentOpts.json)
		},
	}
}

func newCommentsReopenCommand(opts *cliOptions, commentOpts *commentsOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "reopen THREAD_ID",
		Short: "Reopen a resolved local comment thread",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := comments.NewStore(opts.dir)
			if err != nil {
				return err
			}
			thread, err := store.Reopen(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			return printThreadResult(cmd.OutOrStdout(), thread, commentOpts.json)
		},
	}
}

func bodyFromFlag(cmd *cobra.Command, body string) (string, error) {
	if body != "-" {
		return body, nil
	}
	data, err := io.ReadAll(cmd.InOrStdin())
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func printThreadResult(w io.Writer, thread comments.Thread, asJSON bool) error {
	if asJSON {
		return writeJSONCLI(w, thread)
	}
	fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", thread.ID, thread.Status, threadLocation(thread), latestCommentBody(thread))
	return nil
}

func printThreads(w io.Writer, threads []comments.Thread) {
	if len(threads) == 0 {
		fmt.Fprintln(w, "No local comment threads.")
		return
	}
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tSTATUS\tLOCATION\tCOMMENTS\tLATEST")
	for _, thread := range threads {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%d\t%s\n", thread.ID, thread.Status, threadLocation(thread), len(thread.Comments), latestCommentBody(thread))
	}
	_ = tw.Flush()
}

func threadLocation(thread comments.Thread) string {
	endLine := thread.EndLine
	if endLine == 0 {
		endLine = thread.Line
	}
	if endLine == thread.Line {
		return fmt.Sprintf("%s:%d", thread.Path, thread.Line)
	}
	return fmt.Sprintf("%s:%d-%d", thread.Path, thread.Line, endLine)
}

func latestCommentBody(thread comments.Thread) string {
	if len(thread.Comments) == 0 {
		return ""
	}
	body := strings.ReplaceAll(thread.Comments[len(thread.Comments)-1].Body, "\n", " ")
	if len(body) > 72 {
		return body[:69] + "..."
	}
	return body
}
