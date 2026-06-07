//! Storage for guides: ordered, paged, annotated reading flows over a
//! diff. A guide arranges the diff's changed files into named steps; each file
//! belongs to at most one step, and files not claimed by any step fall into a
//! computed "Other changes" pool (never persisted).
//!
//! Mirrors `src/comments.rs`'s file-read/write pattern (atomic temp-file +
//! `fs::rename`, a serializing `Mutex`, `git::root` for the repo root) but the
//! two systems never read or reference each other. Writes go through the CLI
//! only; the HTTP surface (see `src/server.rs`) is read-only.

use crate::git;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GuideError {
    #[error("guide not found")]
    NotFound,
    #[error("guide step not found")]
    StepNotFound,
    #[error("a guide with slug {0:?} already exists")]
    AlreadyExists(String),
    #[error("{0}")]
    Validation(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Git(#[from] git::GitError),
}

pub type Result<T> = std::result::Result<T, GuideError>;

/// A whole guide as persisted to `<repo>/.diffs/guides/<slug>.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    pub version: u32,
    pub slug: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub branch: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub base: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub steps: Vec<Step>,
}

/// One step claims a set of whole changed files and narrates them in Markdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub files: Vec<String>,
}

/// Lightweight row for `list` (CLI table / `GET /api/guides`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub slug: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub branch: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub base: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub steps: usize,
    pub files: usize,
}

/// A step as accepted on input (`--from-json`): id/body optional, id generated
/// when absent.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepInput {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub files: Vec<String>,
}

/// Input for `create`: a blank guide (`steps` empty) or a full import
/// (`--from-json`). Deserializes directly from an imported guide JSON.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInput {
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub base: String,
    #[serde(default)]
    pub steps: Vec<StepInput>,
}

/// Input for `add_step`: claims `files` into a new step.
#[derive(Debug, Clone, Default)]
pub struct AddStepInput {
    pub title: String,
    pub body: String,
    pub files: Vec<String>,
}

/// Input for `update_step`: each `Some` field replaces, `None` leaves it. A
/// `Some(files)` replaces the step's whole file set.
#[derive(Debug, Clone, Default)]
pub struct UpdateStepInput {
    pub title: Option<String>,
    pub body: Option<String>,
    pub files: Option<Vec<String>>,
}

pub struct Store {
    root: PathBuf,
    dir: PathBuf,
    lock: Mutex<()>,
}

impl Store {
    pub fn new(cwd: impl AsRef<Path>) -> Result<Self> {
        let root = git::root(cwd)?;
        let dir = root.join(".diffs").join("guides");
        Ok(Self {
            root,
            dir,
            lock: Mutex::new(()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Current branch, falling back to "local" outside a branch (matches the
    /// comment store, so a guide and a comment thread share the same scope key).
    pub fn branch(&self) -> String {
        let branch = git::branch(&self.root);
        if branch.is_empty() {
            "local".to_string()
        } else {
            branch
        }
    }

    /// All guides in the repo, newest first.
    pub fn list_all(&self) -> Result<Vec<Summary>> {
        let _guard = self.lock.lock().expect("guide store lock poisoned");
        let mut summaries = Vec::new();
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(summaries),
            Err(err) => return Err(err.into()),
        };
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            // Skip atomic-write temp files and any dotfile; only real <slug>.json.
            if name.starts_with('.') || !name.ends_with(".json") {
                continue;
            }
            let data = fs::read_to_string(entry.path())?;
            if data.trim().is_empty() {
                continue;
            }
            // A single corrupt file shouldn't blank the whole list.
            let Ok(file) = serde_json::from_str::<File>(&data) else {
                continue;
            };
            summaries.push(summarize(&file));
        }
        summaries.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.slug.cmp(&b.slug))
        });
        Ok(summaries)
    }

    /// Guides associated with the current branch (by the stored `branch` field).
    pub fn list_for_branch(&self) -> Result<Vec<Summary>> {
        let branch = self.branch();
        Ok(self
            .list_all()?
            .into_iter()
            .filter(|summary| summary.branch == branch)
            .collect())
    }

    pub fn get(&self, slug: &str) -> Result<File> {
        let slug = clean_slug(slug)?;
        let _guard = self.lock.lock().expect("guide store lock poisoned");
        self.load(&slug)
    }

    pub fn create(&self, input: CreateInput) -> Result<File> {
        let slug = clean_slug(&input.slug)?;
        let title = input.title.trim().to_string();
        if title.is_empty() {
            return validation("title is required");
        }
        let now = Utc::now();
        // Build steps, generating ids and validating files against the diff and
        // the one-file-one-step rule before anything touches disk.
        let mut steps: Vec<Step> = Vec::with_capacity(input.steps.len());
        let changed = self.changed_paths()?;
        for raw in input.steps {
            let step_title = raw.title.trim().to_string();
            if step_title.is_empty() {
                return validation("every step requires a title");
            }
            let files = clean_files(raw.files)?;
            validate_in_diff(&files, &changed)?;
            ensure_disjoint(&steps, None, &files)?;
            steps.push(Step {
                id: if raw.id.trim().is_empty() {
                    new_id("stp")
                } else {
                    raw.id.trim().to_string()
                },
                title: step_title,
                body: raw.body,
                files,
            });
        }

        let _guard = self.lock.lock().expect("guide store lock poisoned");
        if self.path(&slug).exists() {
            return Err(GuideError::AlreadyExists(slug));
        }
        let branch = if input.branch.trim().is_empty() {
            self.branch()
        } else {
            input.branch.trim().to_string()
        };
        let file = File {
            version: 1,
            slug,
            title,
            branch,
            base: input.base.trim().to_string(),
            created_at: now,
            updated_at: now,
            steps,
        };
        self.save(&file)?;
        Ok(file)
    }

    pub fn delete(&self, slug: &str) -> Result<()> {
        let slug = clean_slug(slug)?;
        let _guard = self.lock.lock().expect("guide store lock poisoned");
        let path = self.path(&slug);
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(GuideError::NotFound),
            Err(err) => Err(err.into()),
        }
    }

    /// Claims `files` into a new step appended to the end of the guide.
    pub fn add_step(&self, slug: &str, input: AddStepInput) -> Result<File> {
        let slug = clean_slug(slug)?;
        let title = input.title.trim().to_string();
        if title.is_empty() {
            return validation("step title is required");
        }
        let files = clean_files(input.files)?;
        let changed = self.changed_paths()?;
        validate_in_diff(&files, &changed)?;

        let _guard = self.lock.lock().expect("guide store lock poisoned");
        let mut file = self.load(&slug)?;
        ensure_disjoint(&file.steps, None, &files)?;
        file.steps.push(Step {
            id: new_id("stp"),
            title,
            body: input.body,
            files,
        });
        file.updated_at = Utc::now();
        self.save(&file)?;
        Ok(file)
    }

    /// Updates a step in place. A `Some(files)` replaces its whole file set.
    pub fn update_step(&self, slug: &str, step_id: &str, input: UpdateStepInput) -> Result<File> {
        let slug = clean_slug(slug)?;
        let step_id = step_id.trim();
        if step_id.is_empty() {
            return validation("step id is required");
        }
        // Validate replacement files (if any) against the diff up front.
        let cleaned_files = match input.files {
            Some(files) => Some(clean_files(files)?),
            None => None,
        };
        if let Some(files) = &cleaned_files {
            let changed = self.changed_paths()?;
            validate_in_diff(files, &changed)?;
        }

        let _guard = self.lock.lock().expect("guide store lock poisoned");
        let mut file = self.load(&slug)?;
        if !file.steps.iter().any(|step| step.id == step_id) {
            return Err(GuideError::StepNotFound);
        }
        if let Some(files) = &cleaned_files {
            ensure_disjoint(&file.steps, Some(step_id), files)?;
        }
        if let Some(title) = input.title {
            let title = title.trim().to_string();
            if title.is_empty() {
                return validation("step title cannot be empty");
            }
            if let Some(step) = file.steps.iter_mut().find(|s| s.id == step_id) {
                step.title = title;
            }
        }
        if let Some(body) = input.body
            && let Some(step) = file.steps.iter_mut().find(|s| s.id == step_id)
        {
            step.body = body;
        }
        if let Some(files) = cleaned_files
            && let Some(step) = file.steps.iter_mut().find(|s| s.id == step_id)
        {
            step.files = files;
        }
        file.updated_at = Utc::now();
        self.save(&file)?;
        Ok(file)
    }

    /// Removes a step; its files return to the (computed) unannotated pool.
    pub fn remove_step(&self, slug: &str, step_id: &str) -> Result<File> {
        let slug = clean_slug(slug)?;
        let step_id = step_id.trim();
        if step_id.is_empty() {
            return validation("step id is required");
        }
        let _guard = self.lock.lock().expect("guide store lock poisoned");
        let mut file = self.load(&slug)?;
        let original = file.steps.len();
        file.steps.retain(|step| step.id != step_id);
        if file.steps.len() == original {
            return Err(GuideError::StepNotFound);
        }
        file.updated_at = Utc::now();
        self.save(&file)?;
        Ok(file)
    }

    /// Resolves an optional `--slug` to a concrete one for read/step commands:
    /// an explicit slug is validated; an absent slug defaults to the current
    /// branch's single guide (errors on 0 or many).
    pub fn resolve_slug(&self, slug: Option<&str>) -> Result<String> {
        if let Some(slug) = slug.map(str::trim).filter(|s| !s.is_empty()) {
            return clean_slug(slug);
        }
        let mut guides = self.list_for_branch()?;
        match guides.len() {
            0 => validation("no guide for the current branch; pass --slug"),
            1 => Ok(guides.remove(0).slug),
            n => validation(&format!(
                "{n} guides for the current branch; pass --slug to choose one"
            )),
        }
    }

    /// Resolves the slug for `create`: an explicit slug is validated; an absent
    /// one is derived (filename-safe) from the current branch name.
    pub fn create_slug(&self, slug: Option<&str>) -> Result<String> {
        if let Some(slug) = slug.map(str::trim).filter(|s| !s.is_empty()) {
            return clean_slug(slug);
        }
        let derived = slugify(&self.branch());
        if derived.is_empty() {
            return validation("could not derive a slug from the branch; pass --slug");
        }
        clean_slug(&derived)
    }

    /// Forward-slash, repository-relative paths of the current working-tree diff;
    /// the set guide files must belong to.
    fn changed_paths(&self) -> Result<HashSet<String>> {
        Ok(git::changed_files(&self.root)?
            .into_iter()
            .map(|file| file.path)
            .collect())
    }

    fn path(&self, slug: &str) -> PathBuf {
        self.dir.join(format!("{slug}.json"))
    }

    fn load(&self, slug: &str) -> Result<File> {
        let data = match fs::read_to_string(self.path(slug)) {
            Ok(data) => data,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Err(GuideError::NotFound);
            }
            Err(err) => return Err(err.into()),
        };
        let mut file: File = serde_json::from_str(&data)?;
        if file.version == 0 {
            file.version = 1;
        }
        Ok(file)
    }

    fn save(&self, file: &File) -> Result<()> {
        fs::create_dir_all(&self.dir)?;
        let data = serde_json::to_string_pretty(file)? + "\n";
        let tmp_path = self.dir.join(format!(".guides-{}.json", new_id("tmp")));
        fs::write(&tmp_path, data)?;
        fs::rename(&tmp_path, self.path(&file.slug))?;
        Ok(())
    }
}

fn summarize(file: &File) -> Summary {
    let files = file.steps.iter().map(|step| step.files.len()).sum();
    Summary {
        slug: file.slug.clone(),
        title: file.title.clone(),
        branch: file.branch.clone(),
        base: file.base.clone(),
        created_at: file.created_at,
        updated_at: file.updated_at,
        steps: file.steps.len(),
        files,
    }
}

/// Validates and normalizes a slug: a safe, repo-global filename key.
fn clean_slug(slug: &str) -> Result<String> {
    let slug = slug.trim();
    if slug.is_empty() {
        return validation("slug is required");
    }
    if !is_valid_slug(slug) {
        return validation(
            "slug must match ^[a-z0-9][a-z0-9-]*$ (lowercase letters, digits, hyphens)",
        );
    }
    Ok(slug.to_string())
}

fn is_valid_slug(slug: &str) -> bool {
    let mut chars = slug.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    slug.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Derives a filename-safe slug from a branch name: lowercase, non-`[a-z0-9]`
/// runs collapse to a single `-`, leading/trailing `-` trimmed (`feat/x` →
/// `feat-x`).
fn slugify(value: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in value.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Cleans a set of file paths to forward-slash, repo-relative form and rejects
/// empties, parent-traversal, and duplicates within the set.
fn clean_files(files: Vec<String>) -> Result<Vec<String>> {
    let mut cleaned = Vec::with_capacity(files.len());
    let mut seen = HashSet::new();
    for raw in files {
        let path = clean_path(&raw)?;
        if !seen.insert(path.clone()) {
            return validation(&format!("file {path:?} is listed more than once"));
        }
        cleaned.push(path);
    }
    if cleaned.is_empty() {
        return validation("a step must claim at least one file");
    }
    Ok(cleaned)
}

fn clean_path(path: &str) -> Result<String> {
    let path = path.trim().replace('\\', "/");
    if path.is_empty() {
        return validation("file path is required");
    }
    if path.split('/').any(|part| part == "..") {
        return validation("file path must be relative to the repository");
    }
    let mut parts = Vec::new();
    for component in Path::new(&path).components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().to_string()),
            Component::CurDir => {}
            _ => return validation("file path must be relative to the repository"),
        }
    }
    if parts.is_empty() {
        return validation("file path is required");
    }
    Ok(parts.join("/"))
}

/// Rejects files that aren't part of the current diff (deletions and renames
/// included — `git::changed_files` already keys on the new path).
fn validate_in_diff(files: &[String], changed: &HashSet<String>) -> Result<()> {
    for file in files {
        if !changed.contains(file) {
            return validation(&format!("file {file:?} is not part of the current diff"));
        }
    }
    Ok(())
}

/// Enforces one-file-one-step: none of `files` may already belong to a step
/// other than `current` (the step being updated, skipped from the check).
fn ensure_disjoint(steps: &[Step], current: Option<&str>, files: &[String]) -> Result<()> {
    for step in steps {
        if current == Some(step.id.as_str()) {
            continue;
        }
        for file in files {
            if step.files.iter().any(|f| f == file) {
                return validation(&format!(
                    "file {file:?} already belongs to step {:?}",
                    step.id
                ));
            }
        }
    }
    Ok(())
}

fn new_id(prefix: &str) -> String {
    let bytes: [u8; 8] = rand::random();
    format!("{prefix}_{}", hex::encode(bytes))
}

fn validation<T>(message: &str) -> Result<T> {
    Err(GuideError::Validation(message.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }

    /// A repo with a committed base plus working-tree changes, so
    /// `git::changed_files` reports `a.rs`, `b.rs`, and `c.rs`.
    fn new_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run_git(root, &["init", "-b", "main"]);
        run_git(root, &["config", "user.email", "test@example.com"]);
        run_git(root, &["config", "user.name", "Test"]);
        fs::write(root.join("seed.txt"), "seed\n").unwrap();
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "-m", "init"]);
        fs::write(root.join("a.rs"), "a\n").unwrap();
        fs::write(root.join("b.rs"), "b\n").unwrap();
        fs::write(root.join("c.rs"), "c\n").unwrap();
        dir
    }

    fn create_blank(store: &Store, slug: &str) -> File {
        store
            .create(CreateInput {
                slug: slug.to_string(),
                title: "Onboarding".to_string(),
                ..Default::default()
            })
            .unwrap()
    }

    #[test]
    fn create_blank_then_add_list_update_remove_step() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();

        let guide = create_blank(&store, "onboarding");
        assert_eq!(guide.slug, "onboarding");
        assert_eq!(guide.branch, "main");
        assert!(guide.steps.is_empty());

        let guide = store
            .add_step(
                "onboarding",
                AddStepInput {
                    title: "Data model".to_string(),
                    body: "See a.rs".to_string(),
                    files: vec!["a.rs".to_string()],
                },
            )
            .unwrap();
        assert_eq!(guide.steps.len(), 1);
        assert!(guide.steps[0].id.starts_with("stp_"));
        assert_eq!(guide.steps[0].files, vec!["a.rs".to_string()]);

        let step_id = guide.steps[0].id.clone();
        let guide = store
            .update_step(
                "onboarding",
                &step_id,
                UpdateStepInput {
                    title: Some("Model".to_string()),
                    files: Some(vec!["a.rs".to_string(), "b.rs".to_string()]),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(guide.steps[0].title, "Model");
        assert_eq!(guide.steps[0].files.len(), 2);

        let guide = store.remove_step("onboarding", &step_id).unwrap();
        assert!(guide.steps.is_empty());

        store.delete("onboarding").unwrap();
        assert!(matches!(
            store.get("onboarding").unwrap_err(),
            GuideError::NotFound
        ));
    }

    #[test]
    fn create_rejects_duplicate_slug() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();
        create_blank(&store, "dup");
        assert!(matches!(
            store
                .create(CreateInput {
                    slug: "dup".to_string(),
                    title: "x".to_string(),
                    ..Default::default()
                })
                .unwrap_err(),
            GuideError::AlreadyExists(slug) if slug == "dup"
        ));
    }

    #[test]
    fn add_step_rejects_file_already_in_another_step() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();
        create_blank(&store, "g");
        store
            .add_step(
                "g",
                AddStepInput {
                    title: "one".into(),
                    files: vec!["a.rs".into()],
                    ..Default::default()
                },
            )
            .unwrap();
        let err = store
            .add_step(
                "g",
                AddStepInput {
                    title: "two".into(),
                    files: vec!["a.rs".into(), "b.rs".into()],
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(err.to_string().contains("already belongs to step"), "{err}");
    }

    #[test]
    fn update_step_can_keep_its_own_files() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();
        create_blank(&store, "g");
        let guide = store
            .add_step(
                "g",
                AddStepInput {
                    title: "one".into(),
                    files: vec!["a.rs".into()],
                    ..Default::default()
                },
            )
            .unwrap();
        let id = guide.steps[0].id.clone();
        // Re-listing the same file for the same step must not trip the
        // disjointness check against itself.
        let guide = store
            .update_step(
                "g",
                &id,
                UpdateStepInput {
                    files: Some(vec!["a.rs".into(), "b.rs".into()]),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(guide.steps[0].files, vec!["a.rs", "b.rs"]);
    }

    #[test]
    fn add_step_rejects_file_not_in_diff() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();
        create_blank(&store, "g");
        let err = store
            .add_step(
                "g",
                AddStepInput {
                    title: "ghost".into(),
                    files: vec!["does-not-exist.rs".into()],
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(err.to_string().contains("not part of the current diff"), "{err}");
    }

    #[test]
    fn create_from_json_imports_steps_and_generates_ids() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();
        let guide = store
            .create(CreateInput {
                slug: "imported".into(),
                title: "Imported".into(),
                steps: vec![
                    StepInput {
                        title: "first".into(),
                        files: vec!["a.rs".into()],
                        ..Default::default()
                    },
                    StepInput {
                        title: "second".into(),
                        files: vec!["b.rs".into(), "c.rs".into()],
                        ..Default::default()
                    },
                ],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(guide.steps.len(), 2);
        assert!(guide.steps.iter().all(|s| s.id.starts_with("stp_")));
        assert_ne!(guide.steps[0].id, guide.steps[1].id);
    }

    #[test]
    fn create_from_json_rejects_file_in_two_steps() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();
        let err = store
            .create(CreateInput {
                slug: "bad".into(),
                title: "Bad".into(),
                steps: vec![
                    StepInput {
                        title: "first".into(),
                        files: vec!["a.rs".into()],
                        ..Default::default()
                    },
                    StepInput {
                        title: "second".into(),
                        files: vec!["a.rs".into()],
                        ..Default::default()
                    },
                ],
                ..Default::default()
            })
            .unwrap_err();
        assert!(err.to_string().contains("already belongs to step"), "{err}");
    }

    #[test]
    fn list_filters_by_branch() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();
        create_blank(&store, "on-main");

        run_git(dir.path(), &["checkout", "-b", "feature/x"]);
        store
            .create(CreateInput {
                slug: "on-feature".into(),
                title: "Feature".into(),
                ..Default::default()
            })
            .unwrap();

        let scoped = store.list_for_branch().unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].slug, "on-feature");
        assert_eq!(store.list_all().unwrap().len(), 2);
    }

    #[test]
    fn resolve_slug_defaults_to_single_branch_guide() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();
        create_blank(&store, "only");
        assert_eq!(store.resolve_slug(None).unwrap(), "only");
        // Explicit slug always wins.
        assert_eq!(store.resolve_slug(Some("only")).unwrap(), "only");
    }

    #[test]
    fn resolve_slug_errors_when_ambiguous_or_absent() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();
        // None on a branch with no guides.
        assert!(store.resolve_slug(None).is_err());
        create_blank(&store, "a");
        create_blank(&store, "b");
        let err = store.resolve_slug(None).unwrap_err();
        assert!(err.to_string().contains("pass --slug"), "{err}");
    }

    #[test]
    fn create_slug_derives_from_branch() {
        let dir = new_repo();
        run_git(dir.path(), &["checkout", "-b", "feat/Guide_Feature"]);
        let store = Store::new(dir.path()).unwrap();
        assert_eq!(store.create_slug(None).unwrap(), "feat-guide-feature");
    }

    #[test]
    fn slug_validation_rejects_unsafe_names() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();
        for bad in ["", "-x", "../escape", "Upper", "a/b", "a b", "a.b"] {
            assert!(
                store
                    .create(CreateInput {
                        slug: bad.into(),
                        title: "t".into(),
                        ..Default::default()
                    })
                    .is_err(),
                "expected slug {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn guide_round_trips_through_disk() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();
        let created = store
            .create(CreateInput {
                slug: "rt".into(),
                title: "Round trip".into(),
                base: "main".into(),
                steps: vec![StepInput {
                    title: "step".into(),
                    body: "# Heading\n\nbody".into(),
                    files: vec!["a.rs".into()],
                    ..Default::default()
                }],
                ..Default::default()
            })
            .unwrap();

        let reloaded = Store::new(dir.path()).unwrap().get("rt").unwrap();
        assert_eq!(reloaded.title, "Round trip");
        assert_eq!(reloaded.base, "main");
        assert_eq!(reloaded.created_at, created.created_at);
        assert_eq!(reloaded.steps.len(), 1);
        assert_eq!(reloaded.steps[0].body, "# Heading\n\nbody");
        assert_eq!(reloaded.steps[0].id, created.steps[0].id);
    }

    #[test]
    fn slugify_collapses_and_trims() {
        assert_eq!(slugify("feat/x"), "feat-x");
        assert_eq!(slugify("Feature/My Branch!"), "feature-my-branch");
        assert_eq!(slugify("---"), "");
        assert_eq!(slugify("release-1.2"), "release-1-2");
    }
}
