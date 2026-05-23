# diffs

`diffs` is a small Go CLI that serves an embedded React diff review UI.

It has two main modes:

- Local working tree: `diffs` opens `http://127.0.0.1:3433/local` and refreshes staged, unstaged, and untracked changes from filesystem events.
- Pull request review: `diffs https://github.com/org/repo/pull/123` opens the same UI backed by `gh api`.

## Build

```sh
pnpm install
pnpm build
```

The build compiles the web UI into `internal/webassets/dist`, embeds that generated bundle into the Go binary, and writes the final binary to `bin/diffs`.

## Usage

```sh
bin/diffs
bin/diffs /org/repo/pull/123
bin/diffs https://github.com/org/repo/pull/123
bin/diffs --github-host github.example.com /org/repo/pull/123
bin/diffs --host localhost --port 4321 --cwd /path/to/repo
```

The GitHub PR path relies on the GitHub CLI being authenticated for the target host.
