# diffs

`diffs` is a small Go CLI that serves an embedded React diff review UI.

It has two main modes:

- Local working tree: `diffs local` opens `http://127.0.0.1:3433/local` and refreshes staged, unstaged, and untracked changes from filesystem events.
- Pull request review: `diffs pr https://github.com/org/repo/pull/123` opens the same UI backed by `gh api`.

## Build

```sh
pnpm install
pnpm build
```

The build compiles the web UI into `internal/webassets/dist`, embeds that generated bundle into the Go binary, and writes the final CLI binary.

## Usage

```sh
diffs
diffs local
diffs local --host localhost --port 4321 --dir /path/to/repo
diffs pr /org/repo/pull/123
diffs pr https://github.com/org/repo/pull/123
diffs pr --github-host github.example.com /org/repo/pull/123
```

The GitHub PR path relies on the GitHub CLI being authenticated for the target host.

## Configuration

On startup, `diffs` attempts to read `~/.config/diffs/config.toml`. Missing config is ignored.

```toml
[ui]
color_scheme = "system"    # system, light, dark
diff_theme = "github"      # pierre, github, dark-plus, light-plus, one-dark-pro, one-light, monokai, night-owl, tokyo-night
diff_style = "split"       # split, unified
word_wrap = false
line_numbers = true
line_backgrounds = true
```

## Local comments

Local review comments are stored in `.diffs/comments.json` at the git repository root. The `.diffs/` directory is ignored by default, so comments stay local unless you intentionally share that file.

```sh
diffs comments list --dir .
diffs comments list --json --dir .
diffs comments add --dir . --file web/src/App.tsx --line 42 --body "Check this"
diffs comments reply THREAD_ID --dir . --body "Updated note"
diffs comments resolve THREAD_ID --dir .
diffs comments reopen THREAD_ID --dir .
```

Use `--dir /path/to/repo` with any `comments` command to target another repository.
