//! Diff byte-parity gate (MIGRATION §4).
//!
//! The frontend's `@pierre/diffs` parser consumes git's exact unified-diff text,
//! so the libgit2-backed `local_diff`/`branch_diff` must reproduce it. The oracle
//! here is **git itself**. Git is the ground truth the parser targets, and this
//! keeps the harness valid without depending on another implementation.
//!
//! Comparison is per-file: libgit2 emits every file (including untracked) in one
//! path-sorted pass, whereas git's `diff HEAD` + per-file `--no-index` untracked
//! pipeline appends untracked last, so the global byte order differs legitimately.
//! The parser handles each `diff --git` block independently, so per-file byte
//! parity is the meaningful contract.

use std::collections::BTreeMap;
use std::path::Path;
use std::{fs, process::Command};

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .expect("run git");
    assert!(status.success(), "git {args:?} failed");
}

fn git_output(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("run git");
    assert!(output.status.success(), "git {args:?} failed");
    String::from_utf8(output.stdout).expect("git output is utf8")
}

fn init_repo(dir: &Path) {
    git(dir, &["init"]);
    git(dir, &["config", "user.email", "diffs@example.com"]);
    git(dir, &["config", "user.name", "Diffs Test"]);
    // Pin diff rendering so the oracle is deterministic across host git configs.
    git(dir, &["config", "core.autocrlf", "false"]);
    git(dir, &["config", "diff.renames", "true"]);
}

/// Appends a `git diff --no-index` block for every untracked file, mirroring the
/// server's `untrackedPatch`. `--no-index` exits 1 when files differ.
fn append_untracked(dir: &Path, patch: &mut String) {
    let untracked = git_output(dir, &["ls-files", "--others", "--exclude-standard", "-z"]);
    for name in untracked.split('\0').filter(|name| !name.is_empty()) {
        let out = Command::new("git")
            .args([
                "diff",
                "--no-ext-diff",
                "--patch",
                "--no-index",
                "--",
                "/dev/null",
                name,
            ])
            .current_dir(dir)
            .output()
            .expect("run git no-index");
        assert_eq!(out.status.code(), Some(1), "git diff --no-index for {name}");
        if !patch.is_empty() && !patch.ends_with('\n') {
            patch.push('\n');
        }
        patch.push_str(&String::from_utf8(out.stdout).expect("no-index output is utf8"));
    }
}

/// Reconstructs the server's `localDiff` reference (HEAD present).
fn git_local_patch(dir: &Path) -> String {
    let mut patch = git_output(
        dir,
        &[
            "diff",
            "--no-ext-diff",
            "--patch",
            "--submodule=diff",
            "HEAD",
            "--",
        ],
    );
    append_untracked(dir, &mut patch);
    patch
}

/// Reconstructs the server's `localDiff` reference for a repo with no HEAD:
/// staged (`--cached`) then unstaged then untracked.
fn git_local_patch_no_head(dir: &Path) -> String {
    let mut patch = git_output(
        dir,
        &[
            "diff",
            "--no-ext-diff",
            "--patch",
            "--submodule=diff",
            "--cached",
            "--",
        ],
    );
    let unstaged = git_output(
        dir,
        &["diff", "--no-ext-diff", "--patch", "--submodule=diff", "--"],
    );
    if !patch.is_empty() && !patch.ends_with('\n') {
        patch.push('\n');
    }
    patch.push_str(&unstaged);
    append_untracked(dir, &mut patch);
    patch
}

/// Reconstructs `branchDiff` (three-dot) reference.
fn git_branch_patch(dir: &Path, base: &str) -> String {
    git_output(
        dir,
        &[
            "diff",
            "--no-ext-diff",
            "--patch",
            "--submodule=diff",
            &format!("{base}...HEAD"),
            "--",
        ],
    )
}

/// Reconstructs `branchDiffWithDirty` reference: merge-base to working tree,
/// plus untracked files.
fn git_branch_dirty_patch(dir: &Path, base: &str) -> String {
    let merge_base = git_output(dir, &["merge-base", base, "HEAD"])
        .trim()
        .to_string();
    let mut patch = git_output(
        dir,
        &[
            "diff",
            "--no-ext-diff",
            "--patch",
            "--submodule=diff",
            &merge_base,
            "--",
        ],
    );
    append_untracked(dir, &mut patch);
    patch
}

/// Splits a unified diff into per-file blocks keyed by the `diff --git` header.
fn split_files(patch: &str) -> BTreeMap<String, String> {
    let mut blocks = BTreeMap::new();
    let mut key: Option<String> = None;
    let mut buf = String::new();
    for line in patch.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            if let Some(key) = key.take() {
                blocks.insert(key, std::mem::take(&mut buf));
            }
            key = Some(line.trim_end().to_string());
        }
        buf.push_str(line);
    }
    if let Some(key) = key.take() {
        blocks.insert(key, buf);
    }
    blocks
}

fn assert_per_file_parity(rust: &str, git: &str) {
    assert_eq!(
        split_files(rust),
        split_files(git),
        "per-file diff text must match git byte-for-byte"
    );
}

#[test]
fn local_diff_matches_git_for_rich_fixture() {
    let repo = tempfile::tempdir().unwrap();
    let dir = repo.path();
    init_repo(dir);

    fs::write(dir.join("modified.txt"), "before\n").unwrap();
    fs::write(dir.join("deleted.txt"), "bye\n").unwrap();
    fs::write(dir.join("renamed.txt"), "rename me unchanged\n").unwrap();
    fs::write(dir.join("nonewline.txt"), "first\nsecond\n").unwrap();
    fs::write(dir.join("crlf.txt"), "a\r\nb\r\n").unwrap();
    fs::write(dir.join("binary.bin"), [0u8, 1, 2, 3, 0, 255, 10]).unwrap();
    fs::write(dir.join("mode.sh"), "echo hi\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-m", "initial"]);

    // Worktree + index changes covering the §4 divergence points.
    fs::write(dir.join("modified.txt"), "before\nafter\n").unwrap();
    fs::remove_file(dir.join("deleted.txt")).unwrap();
    git(dir, &["mv", "renamed.txt", "renamed-new.txt"]); // staged rename
    fs::write(dir.join("nonewline.txt"), "first\nsecond").unwrap(); // drop trailing newline
    fs::write(dir.join("crlf.txt"), "a\r\nb\r\nc\r\n").unwrap();
    fs::write(dir.join("binary.bin"), [0u8, 9, 9, 9, 0, 1, 10]).unwrap();
    fs::write(dir.join("untracked.txt"), "new\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir.join("mode.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    }

    let rust_patch = diffs::git::local_diff(dir).unwrap();
    let git_patch = git_local_patch(dir);
    assert_per_file_parity(&rust_patch, &git_patch);
}

#[test]
fn local_diff_matches_git_for_empty_repo() {
    let repo = tempfile::tempdir().unwrap();
    let dir = repo.path();
    init_repo(dir);

    // No commit -> no HEAD. Mix of staged, unstaged-modified, and untracked.
    fs::write(dir.join("staged.txt"), "staged\n").unwrap();
    git(dir, &["add", "staged.txt"]);
    fs::write(dir.join("staged.txt"), "staged\nedited\n").unwrap(); // staged + further unstaged edit
    fs::write(dir.join("untracked.txt"), "loose\n").unwrap();

    let rust_patch = diffs::git::local_diff(dir).unwrap();
    let git_patch = git_local_patch_no_head(dir);
    assert_per_file_parity(&rust_patch, &git_patch);
}

#[test]
fn branch_diff_three_dot_matches_git() {
    let repo = tempfile::tempdir().unwrap();
    let dir = repo.path();
    init_repo(dir);

    fs::write(dir.join("base.txt"), "base\n").unwrap();
    fs::write(dir.join("shared.txt"), "v1\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-m", "initial"]);
    git(dir, &["branch", "-M", "main"]); // deterministic base name across git versions

    // Diverge main with a commit the feature branch should not see (three-dot).
    git(dir, &["checkout", "-q", "-b", "feature"]);
    fs::write(dir.join("feature.txt"), "added on feature\n").unwrap();
    fs::write(dir.join("shared.txt"), "v2\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-m", "feature work"]);

    git(dir, &["checkout", "-q", "main"]);
    fs::write(dir.join("base.txt"), "base changed on main\n").unwrap();
    git(dir, &["commit", "-am", "main moves on"]);
    git(dir, &["checkout", "-q", "feature"]);

    let rust_patch = diffs::git::branch_diff(dir, "main", false).unwrap();
    let git_patch = git_branch_patch(dir, "main");
    assert_per_file_parity(&rust_patch, &git_patch);
}

#[test]
fn branch_diff_include_dirty_matches_git() {
    let repo = tempfile::tempdir().unwrap();
    let dir = repo.path();
    init_repo(dir);

    fs::write(dir.join("base.txt"), "base\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-m", "initial"]);
    git(dir, &["branch", "-M", "main"]); // deterministic base name across git versions

    git(dir, &["checkout", "-q", "-b", "feature"]);
    fs::write(dir.join("committed.txt"), "committed on feature\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-m", "feature commit"]);

    // Dirty working tree on top of the committed branch work.
    fs::write(dir.join("base.txt"), "base dirty edit\n").unwrap();
    fs::write(dir.join("untracked.txt"), "loose\n").unwrap();

    let rust_patch = diffs::git::branch_diff(dir, "main", true).unwrap();
    let git_patch = git_branch_dirty_patch(dir, "main");
    assert_per_file_parity(&rust_patch, &git_patch);
}
