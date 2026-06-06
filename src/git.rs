use git2::{
    BranchType, Diff, DiffFindOptions, DiffFormat, DiffOptions, ErrorCode, ObjectType, Oid,
    Repository, Status, StatusOptions,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitError {
    #[error("not a git repository")]
    NotRepository,
    #[error(transparent)]
    Git(#[from] git2::Error),
    #[error("repository has no working tree")]
    NoWorkdir,
    #[error("invalid utf-8 path in repository")]
    InvalidPath,
}

pub type Result<T> = std::result::Result<T, GitError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeAction {
    Added,
    Modified,
    Deleted,
    Renamed,
}

impl ChangeAction {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeAction::Added => "added",
            ChangeAction::Modified => "modified",
            ChangeAction::Deleted => "deleted",
            ChangeAction::Renamed => "renamed",
        }
    }
}

/// Maps a git2 status to a `ChangeAction` using the same precedence as the Go
/// watcher's `gitStatusAction`: deletion, then rename/copy, then addition,
/// otherwise modification.
fn status_action(status: Status) -> ChangeAction {
    if status.intersects(Status::INDEX_DELETED | Status::WT_DELETED) {
        ChangeAction::Deleted
    } else if status.intersects(Status::INDEX_RENAMED | Status::WT_RENAMED) {
        ChangeAction::Renamed
    } else if status.intersects(Status::INDEX_NEW | Status::WT_NEW) {
        ChangeAction::Added
    } else {
        ChangeAction::Modified
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub action: ChangeAction,
}

pub fn discover(cwd: impl AsRef<Path>) -> Result<Repository> {
    Repository::discover(cwd).map_err(|err| {
        if err.code() == ErrorCode::NotFound {
            GitError::NotRepository
        } else {
            GitError::Git(err)
        }
    })
}

pub fn root(cwd: impl AsRef<Path>) -> Result<PathBuf> {
    let repo = discover(cwd)?;
    repo.workdir()
        .map(Path::to_path_buf)
        .ok_or(GitError::NoWorkdir)
}

pub fn branch(cwd: impl AsRef<Path>) -> String {
    discover(cwd)
        .ok()
        .and_then(|repo| branch_for_repo(&repo).ok())
        .unwrap_or_default()
}

pub fn branch_for_repo(repo: &Repository) -> Result<String> {
    match repo.head() {
        Ok(head) => {
            if let Some(name) = head.shorthand().filter(|name| !name.is_empty()) {
                return Ok(name.to_string());
            }
            // Detached HEAD: fall back to the short commit oid.
            let commit = head.peel_to_commit()?;
            Ok(commit.id().to_string().chars().take(7).collect())
        }
        // Unborn branch (fresh repo, no commits yet): `git branch --show-current`
        // still reports the branch HEAD points at, so read it from the symref.
        Err(err) if err.code() == ErrorCode::UnbornBranch => {
            head_branch_name(repo).ok_or(GitError::Git(err))
        }
        Err(err) => Err(GitError::Git(err)),
    }
}

fn head_branch_name(repo: &Repository) -> Option<String> {
    let head = repo.find_reference("HEAD").ok()?;
    let target = head.symbolic_target()?;
    target
        .strip_prefix("refs/heads/")
        .map(|name| name.to_string())
}

pub fn ref_exists(cwd: impl AsRef<Path>, name: &str) -> bool {
    discover(cwd)
        .and_then(|repo| {
            repo.revparse_single(name)?
                .peel(ObjectType::Commit)
                .map(|_| ())
                .map_err(GitError::from)
        })
        .is_ok()
}

pub fn resolve_local_ref(cwd: impl AsRef<Path>, name: &str) -> Option<String> {
    if ref_exists(&cwd, name) {
        return Some(name.to_string());
    }
    let candidate = format!("origin/{name}");
    ref_exists(cwd, &candidate).then_some(candidate)
}

pub fn remote_url(cwd: impl AsRef<Path>, remote: &str) -> Result<String> {
    let repo = discover(cwd)?;
    Ok(repo
        .find_remote(remote)?
        .url()
        .unwrap_or_default()
        .to_string())
}

pub fn config_string(cwd: impl AsRef<Path>, key: &str) -> Option<String> {
    discover(cwd)
        .ok()
        .and_then(|repo| repo.config().ok())
        .and_then(|cfg| cfg.get_string(key).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn has_head(repo: &Repository) -> bool {
    repo.head()
        .and_then(|head| head.peel_to_commit())
        .map(|_| ())
        .is_ok()
}

pub fn local_diff(cwd: impl AsRef<Path>) -> Result<String> {
    let repo = discover(cwd)?;
    if has_head(&repo) {
        // Working tree (with index) vs HEAD, with untracked files inline.
        let head_tree = repo.head()?.peel_to_tree()?;
        let mut opts = diff_options();
        render(repo.diff_tree_to_workdir_with_index(Some(&head_tree), Some(&mut opts))?)
    } else {
        // No HEAD yet: staged (empty tree -> index) then unstaged (index -> workdir).
        let index = repo.index()?;
        let mut patch = String::new();
        let mut staged_opts = diff_options();
        append_diff(
            &mut patch,
            repo.diff_tree_to_index(None, Some(&index), Some(&mut staged_opts))?,
        )?;
        let mut workdir_opts = diff_options();
        append_diff(
            &mut patch,
            repo.diff_index_to_workdir(Some(&index), Some(&mut workdir_opts))?,
        )?;
        Ok(patch)
    }
}

pub fn branch_diff(cwd: impl AsRef<Path>, base: &str, include_dirty: bool) -> Result<String> {
    let repo = discover(cwd)?;
    let head = repo.head()?.peel_to_commit()?;
    let base_commit = repo.revparse_single(base)?.peel_to_commit()?;
    let merge_base = repo.merge_base(base_commit.id(), head.id())?;
    if include_dirty {
        diff_oid_to_workdir(&repo, merge_base)
    } else {
        diff_oid_to_tree(&repo, merge_base, head.id())
    }
}

fn diff_oid_to_tree(repo: &Repository, from: Oid, to: Oid) -> Result<String> {
    let from_tree = repo.find_commit(from)?.tree()?;
    let to_tree = repo.find_commit(to)?.tree()?;
    let mut opts = diff_options();
    render(repo.diff_tree_to_tree(Some(&from_tree), Some(&to_tree), Some(&mut opts))?)
}

fn diff_oid_to_workdir(repo: &Repository, from: Oid) -> Result<String> {
    let tree = repo.find_commit(from)?.tree()?;
    let mut opts = diff_options();
    render(repo.diff_tree_to_workdir_with_index(Some(&tree), Some(&mut opts))?)
}

/// Renders a prepared diff (with rename detection) to unified-diff text.
fn render(diff: Diff<'_>) -> Result<String> {
    let mut patch = String::new();
    append_diff(&mut patch, diff)?;
    Ok(patch)
}

fn diff_options() -> DiffOptions {
    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .show_untracked_content(true)
        .recurse_untracked_dirs(true)
        .include_typechange(true)
        .include_typechange_trees(true)
        .ignore_submodules(false);
    opts
}

fn append_diff(output: &mut String, mut diff: Diff<'_>) -> Result<()> {
    let mut find = DiffFindOptions::new();
    find.renames(true).copies(false);
    let _ = diff.find_similar(Some(&mut find));

    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        if matches!(line.origin(), ' ' | '+' | '-' | '\\') {
            output.push(line.origin());
        }
        if let Ok(text) = std::str::from_utf8(line.content()) {
            output.push_str(text);
        } else {
            output.push_str(&String::from_utf8_lossy(line.content()));
        }
        true
    })?;
    if !output.is_empty() && !output.ends_with('\n') {
        output.push('\n');
    }
    Ok(())
}

fn status_options() -> StatusOptions {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    opts
}

fn status_entry_path(entry: &git2::StatusEntry<'_>) -> Option<String> {
    entry
        .head_to_index()
        .and_then(|d| d.new_file().path())
        .or_else(|| entry.index_to_workdir().and_then(|d| d.new_file().path()))
        .or_else(|| entry.path().map(Path::new))
        .map(|path| path.to_string_lossy().replace('\\', "/"))
}

pub fn changed_files(cwd: impl AsRef<Path>) -> Result<Vec<ChangedFile>> {
    let repo = discover(cwd)?;
    let statuses = repo.statuses(Some(&mut status_options()))?;
    let mut files = Vec::new();
    for entry in statuses.iter() {
        let path = status_entry_path(&entry).ok_or(GitError::InvalidPath)?;
        files.push(ChangedFile {
            path,
            action: status_action(entry.status()),
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files.dedup_by(|a, b| a.path == b.path);
    Ok(files)
}

/// Builds a map of repository-relative (forward-slash) path → change action,
/// mirroring Go's `gitStatus`. Used by the watcher to label changed files for
/// the reload logger.
pub fn status_map(repo: &Repository) -> Result<BTreeMap<String, ChangeAction>> {
    let statuses = repo.statuses(Some(&mut status_options()))?;
    let mut map = BTreeMap::new();
    for entry in statuses.iter() {
        if let Some(path) = status_entry_path(&entry) {
            map.insert(path, status_action(entry.status()));
        }
    }
    Ok(map)
}

pub fn default_branch(cwd: impl AsRef<Path>) -> Option<String> {
    let repo = discover(cwd).ok()?;
    for candidate in ["main", "master"] {
        if repo.find_branch(candidate, BranchType::Local).is_ok() {
            return Some(candidate.to_string());
        }
        let origin = format!("origin/{candidate}");
        if ref_exists(repo.workdir()?, &origin) {
            return Some(origin);
        }
    }
    None
}

/// Reports whether `path` is ignored by the repository's gitignore rules, using
/// libgit2's native matcher (the full hierarchy: nested `.gitignore`,
/// `.git/info/exclude`, and the global `core.excludesFile`). Paths outside the
/// working tree, or any lookup error, are treated as not ignored.
pub fn is_path_ignored(repo: &Repository, path: impl AsRef<Path>) -> bool {
    let path = path.as_ref();
    let Some(workdir) = repo.workdir() else {
        return false;
    };
    let Some(relative) = workdir_relative_path(workdir, path) else {
        return false;
    };
    repo.is_path_ignored(Path::new(&relative)).unwrap_or(false)
}

fn workdir_relative_path(workdir: &Path, path: &Path) -> Option<String> {
    if let Ok(relative) = path.strip_prefix(workdir) {
        return Some(git_path(relative));
    }

    if let Ok(workdir) = workdir.canonicalize()
        && let Ok(relative) = path.strip_prefix(workdir)
    {
        return Some(git_path(relative));
    }

    strip_git_path_prefix(&git_path(path), &git_path(workdir))
}

fn git_path(path: &Path) -> String {
    let path = path.to_string_lossy().replace('\\', "/");
    path.strip_prefix("//?/").unwrap_or(&path).to_string()
}

fn strip_git_path_prefix(path: &str, workdir: &str) -> Option<String> {
    let workdir = workdir.trim_end_matches('/');
    if path.eq_ignore_ascii_case(workdir) {
        return Some(String::new());
    }

    let prefix = format!("{workdir}/");
    path.get(prefix.len()..)
        .filter(|_| path[..prefix.len()].eq_ignore_ascii_case(&prefix))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command};

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }

    #[test]
    fn patch_lines_include_unified_diff_origin_prefixes() {
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init"]);
        git(repo.path(), &["config", "user.email", "diffs@example.com"]);
        git(repo.path(), &["config", "user.name", "Diffs Test"]);
        fs::write(repo.path().join("tracked.txt"), "one\n").unwrap();
        git(repo.path(), &["add", "."]);
        git(repo.path(), &["commit", "-m", "initial"]);

        fs::write(repo.path().join("tracked.txt"), "one\ntwo\n").unwrap();
        fs::write(repo.path().join("untracked.txt"), "new\n").unwrap();

        let patch = local_diff(repo.path()).unwrap();
        assert!(patch.contains(" one\n"), "{patch}");
        assert!(patch.contains("+two\n"), "{patch}");
        assert!(patch.contains("+new\n"), "{patch}");
    }

    #[test]
    fn is_path_ignored_honors_gitignore_hierarchy() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init"]);
        // Canonicalize like server::new does, so paths share libgit2's workdir
        // prefix (macOS temp dirs are /var -> /private/var symlinks otherwise).
        let root = dir.path().canonicalize().unwrap();
        fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("nested/.gitignore"), "secret.txt\n").unwrap();
        fs::write(root.join("target/app"), "").unwrap();
        fs::write(root.join("debug.log"), "").unwrap();
        fs::write(root.join("nested/secret.txt"), "").unwrap();
        fs::write(root.join("src/main.rs"), "").unwrap();
        let repo = discover(&root).unwrap();

        assert!(is_path_ignored(&repo, root.join("target/app")));
        assert!(is_path_ignored(&repo, root.join("debug.log")));
        assert!(is_path_ignored(&repo, root.join("nested/secret.txt")));
        assert!(!is_path_ignored(&repo, root.join("src/main.rs")));
        // Paths outside the working tree must not be treated as ignored.
        assert!(!is_path_ignored(&repo, "/etc/hosts"));
    }
}
