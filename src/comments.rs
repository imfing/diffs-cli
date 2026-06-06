use crate::git;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use thiserror::Error;

pub const DEFAULT_AUTHOR: &str = "local";
pub const DEFAULT_SIDE: &str = "additions";

#[derive(Debug, Error)]
pub enum CommentError {
    #[error("comment thread not found")]
    NotFound,
    #[error("{0}")]
    Validation(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Git(#[from] git::GitError),
}

pub type Result<T> = std::result::Result<T, CommentError>;

#[derive(Debug, Serialize, Deserialize)]
pub struct File {
    pub version: u8,
    pub repo: String,
    #[serde(default)]
    pub threads: Vec<Thread>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub provider: String,
    pub branch: String,
    pub path: String,
    pub side: String,
    pub line: u32,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    pub end_side: String,
    #[serde(skip_serializing_if = "is_zero", default)]
    pub end_line: u32,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub comments: Vec<Comment>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reply_to_id: Option<i64>,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddThreadInput {
    pub path: String,
    pub side: String,
    pub line: u32,
    #[serde(default)]
    pub end_side: String,
    #[serde(default)]
    pub end_line: u32,
    pub body: String,
    #[serde(default)]
    pub author: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AddReplyInput {
    pub body: String,
    #[serde(default)]
    pub author: String,
}

pub struct Store {
    root: PathBuf,
    path: PathBuf,
    lock: Mutex<()>,
}

impl Store {
    pub fn new(cwd: impl AsRef<Path>) -> Result<Self> {
        let root = git::root(cwd)?;
        let path = root.join(".diffs").join("comments.json");
        Ok(Self {
            root,
            path,
            lock: Mutex::new(()),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn branch(&self) -> String {
        let branch = git::branch(&self.root);
        if branch.is_empty() {
            "local".to_string()
        } else {
            branch
        }
    }

    pub fn list(&self) -> Result<Vec<Thread>> {
        let _guard = self.lock.lock().expect("comment store lock poisoned");
        let file = self.load()?;
        let branch = self.branch();
        Ok(file
            .threads
            .into_iter()
            .filter(|thread| thread.branch == branch)
            .collect())
    }

    pub fn add_thread(&self, input: AddThreadInput) -> Result<Thread> {
        let clean = clean_thread_input(input.clone())?;
        let author = clean_author(&self.root, input.author);
        let now = Utc::now();
        let mut thread = Thread {
            id: new_id("thr"),
            provider: "local".to_string(),
            // Stamped under the lock below so it matches the snapshot list()
            // and update_thread() read, even if a branch switch races us.
            branch: String::new(),
            path: clean.path,
            side: clean.side.clone(),
            line: clean.line,
            end_side: String::new(),
            end_line: 0,
            status: "open".to_string(),
            created_at: now,
            updated_at: now,
            comments: vec![Comment {
                id: new_id("cmt"),
                author,
                body: clean.body,
                created_at: now,
            }],
            reply_to_id: None,
            url: String::new(),
        };
        if clean.end_line != clean.line || clean.end_side != clean.side {
            thread.end_side = clean.end_side;
            thread.end_line = clean.end_line;
        }

        let _guard = self.lock.lock().expect("comment store lock poisoned");
        thread.branch = self.branch();
        let mut file = self.load()?;
        file.threads.push(thread.clone());
        self.save(file)?;
        Ok(thread)
    }

    pub fn add_reply(&self, thread_id: &str, input: AddReplyInput) -> Result<Thread> {
        let body = input.body.trim().to_string();
        if body.is_empty() {
            return validation("body is required");
        }
        let author = clean_author(&self.root, input.author);
        self.update_thread(thread_id, |thread, now| {
            thread.comments.push(Comment {
                id: new_id("cmt"),
                author,
                body,
                created_at: now,
            });
            thread.updated_at = now;
        })
    }

    pub fn resolve(&self, thread_id: &str) -> Result<Thread> {
        self.set_status(thread_id, "resolved")
    }

    pub fn reopen(&self, thread_id: &str) -> Result<Thread> {
        self.set_status(thread_id, "open")
    }

    pub fn delete(&self, thread_id: &str) -> Result<()> {
        let thread_id = thread_id.trim();
        if thread_id.is_empty() {
            return validation("thread id is required");
        }
        let _guard = self.lock.lock().expect("comment store lock poisoned");
        let mut file = self.load()?;
        let branch = self.branch();
        let original_len = file.threads.len();
        file.threads
            .retain(|thread| thread.id != thread_id || thread.branch != branch);
        if file.threads.len() == original_len {
            return Err(CommentError::NotFound);
        }
        self.save(file)
    }

    fn set_status(&self, thread_id: &str, status: &str) -> Result<Thread> {
        self.update_thread(thread_id, |thread, now| {
            thread.status = status.to_string();
            thread.updated_at = now;
        })
    }

    fn update_thread(
        &self,
        thread_id: &str,
        update: impl FnOnce(&mut Thread, DateTime<Utc>),
    ) -> Result<Thread> {
        let thread_id = thread_id.trim();
        if thread_id.is_empty() {
            return validation("thread id is required");
        }
        let _guard = self.lock.lock().expect("comment store lock poisoned");
        let mut file = self.load()?;
        let branch = self.branch();
        for thread in &mut file.threads {
            if thread.id != thread_id || thread.branch != branch {
                continue;
            }
            update(thread, Utc::now());
            let updated = thread.clone();
            self.save(file)?;
            return Ok(updated);
        }
        Err(CommentError::NotFound)
    }

    fn load(&self) -> Result<File> {
        let data = match fs::read_to_string(&self.path) {
            Ok(data) => data,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(self.empty_file()),
            Err(err) => return Err(err.into()),
        };
        if data.trim().is_empty() {
            return Ok(self.empty_file());
        }
        let mut file: File = serde_json::from_str(&data)?;
        if file.version == 0 {
            file.version = 1;
        }
        if file.repo.is_empty() {
            file.repo = self.root_string();
        }
        Ok(file)
    }

    fn save(&self, mut file: File) -> Result<()> {
        file.version = 1;
        file.repo = self.root_string();
        let dir = self
            .path
            .parent()
            .ok_or_else(|| CommentError::Validation("comment path has no parent".to_string()))?;
        fs::create_dir_all(dir)?;
        let data = serde_json::to_string_pretty(&file)? + "\n";
        let tmp_name = format!(".comments-{}.json", new_id("tmp"));
        let tmp_path = dir.join(tmp_name);
        fs::write(&tmp_path, data)?;
        fs::rename(&tmp_path, &self.path)?;
        Ok(())
    }

    fn empty_file(&self) -> File {
        File {
            version: 1,
            repo: self.root_string(),
            threads: Vec::new(),
        }
    }

    fn root_string(&self) -> String {
        self.root.to_string_lossy().to_string()
    }
}

#[derive(Debug)]
pub struct CleanThread {
    pub path: String,
    pub side: String,
    pub line: u32,
    pub end_side: String,
    pub end_line: u32,
    pub body: String,
}

pub fn clean_thread_input(input: AddThreadInput) -> Result<CleanThread> {
    let mut path = input.path.trim().replace('\\', "/");
    let mut side = input.side.trim().to_string();
    let mut end_side = input.end_side.trim().to_string();
    let body = input.body.trim().to_string();
    if path.is_empty() {
        return validation("path is required");
    }
    if has_parent_path_segment(&path) {
        return validation("path must be relative to the repository");
    }
    path = clean_slash_path(&path)?;
    if input.line < 1 {
        return validation("line must be greater than zero");
    }
    let end_line = if input.end_line == 0 {
        input.line
    } else {
        input.end_line
    };
    if end_line < 1 {
        return validation("end line must be greater than zero");
    }
    if end_line < input.line {
        return validation("end line must be greater than or equal to line");
    }
    if side.is_empty() {
        side = DEFAULT_SIDE.to_string();
    }
    if end_side.is_empty() {
        end_side = side.clone();
    }
    if side != "additions" && side != "deletions" {
        return validation("side must be additions or deletions");
    }
    if end_side != "additions" && end_side != "deletions" {
        return validation("end side must be additions or deletions");
    }
    if body.is_empty() {
        return validation("body is required");
    }
    Ok(CleanThread {
        path,
        side,
        line: input.line,
        end_side,
        end_line,
        body,
    })
}

fn clean_slash_path(path: &str) -> Result<String> {
    let mut parts = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().to_string()),
            Component::CurDir => {}
            _ => return validation("path must be relative to the repository"),
        }
    }
    if parts.is_empty() {
        return validation("path is required");
    }
    Ok(parts.join("/"))
}

fn has_parent_path_segment(path: &str) -> bool {
    path.split('/').any(|part| part == "..")
}

fn clean_author(root: &Path, author: String) -> String {
    let author = author.trim();
    if !author.is_empty() {
        return author.to_string();
    }
    git::config_string(root, "user.name").unwrap_or_else(|| DEFAULT_AUTHOR.to_string())
}

fn new_id(prefix: &str) -> String {
    let bytes: [u8; 8] = rand::random();
    format!("{prefix}_{}", hex::encode(bytes))
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

fn validation<T>(message: &str) -> Result<T> {
    Err(CommentError::Validation(message.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_thread_input_defaults_range_end() {
        let clean = clean_thread_input(AddThreadInput {
            path: " src\\main.rs ".to_string(),
            line: 3,
            body: " hi ".to_string(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(clean.path, "src/main.rs");
        assert_eq!(clean.side, "additions");
        assert_eq!(clean.end_side, "additions");
        assert_eq!(clean.end_line, 3);
        assert_eq!(clean.body, "hi");
    }

    #[test]
    fn clean_thread_input_rejects_parent_paths() {
        let err = clean_thread_input(AddThreadInput {
            path: "../secret".to_string(),
            line: 1,
            body: "body".to_string(),
            ..Default::default()
        })
        .unwrap_err();
        assert!(err.to_string().contains("path must be relative"));
    }

    #[test]
    fn clean_thread_input_rejects_invalid_table() {
        let bad = [
            AddThreadInput {
                path: "".into(),
                line: 1,
                body: "b".into(),
                ..Default::default()
            },
            AddThreadInput {
                path: "../outside".into(),
                line: 1,
                body: "b".into(),
                ..Default::default()
            },
            AddThreadInput {
                path: "a/../b".into(),
                line: 1,
                body: "b".into(),
                ..Default::default()
            },
            AddThreadInput {
                path: "a/../../outside".into(),
                line: 1,
                body: "b".into(),
                ..Default::default()
            },
            AddThreadInput {
                path: "a\\..\\b".into(),
                line: 1,
                body: "b".into(),
                ..Default::default()
            },
            AddThreadInput {
                path: "a.go".into(),
                line: 0,
                body: "b".into(),
                ..Default::default()
            },
            AddThreadInput {
                path: "a.go".into(),
                line: 10,
                end_line: 1,
                body: "b".into(),
                ..Default::default()
            },
            AddThreadInput {
                path: "a.go".into(),
                line: 1,
                side: "right".into(),
                body: "b".into(),
                ..Default::default()
            },
            AddThreadInput {
                path: "a.go".into(),
                line: 1,
                end_side: "right".into(),
                body: "b".into(),
                ..Default::default()
            },
            AddThreadInput {
                path: "a.go".into(),
                line: 1,
                body: "".into(),
                ..Default::default()
            },
        ];
        for input in bad {
            assert!(
                clean_thread_input(input.clone()).is_err(),
                "expected error for {input:?}"
            );
        }
    }

    fn run_git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }

    fn new_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        run_git(dir.path(), &["init", "-b", "main"]);
        run_git(dir.path(), &["config", "user.email", "test@example.com"]);
        run_git(dir.path(), &["config", "user.name", "Test"]);
        dir
    }

    #[test]
    fn store_lifecycle_add_reply_resolve_reopen_delete() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();

        let thread = store
            .add_thread(AddThreadInput {
                path: "web/src/App.tsx".into(),
                line: 42,
                end_line: 45,
                side: "additions".into(),
                body: "Check this".into(),
                ..Default::default()
            })
            .unwrap();
        assert!(!thread.id.is_empty());
        assert_eq!(thread.provider, "local");
        assert_eq!(thread.status, "open");
        assert_eq!(thread.branch, "main");
        assert_eq!((thread.line, thread.end_line), (42, 45));
        assert_eq!(
            (thread.side.as_str(), thread.end_side.as_str()),
            ("additions", "additions")
        );
        assert_eq!(thread.comments.len(), 1);
        assert_eq!(thread.comments[0].body, "Check this");
        assert_eq!(thread.comments[0].author, "Test"); // from repo user.name

        let thread = store
            .add_reply(
                &thread.id,
                AddReplyInput {
                    body: "Reply".into(),
                    author: "agent".into(),
                },
            )
            .unwrap();
        assert_eq!(thread.comments.len(), 2);
        assert_eq!(thread.comments[1].body, "Reply");
        assert_eq!(thread.comments[1].author, "agent");

        assert_eq!(store.resolve(&thread.id).unwrap().status, "resolved");
        assert_eq!(store.reopen(&thread.id).unwrap().status, "open");

        store.delete(&thread.id).unwrap();
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn store_lists_current_branch_only() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();
        store
            .add_thread(AddThreadInput {
                path: "a.go".into(),
                line: 1,
                body: "main".into(),
                ..Default::default()
            })
            .unwrap();

        run_git(dir.path(), &["checkout", "-b", "feature/comments"]);
        store
            .add_thread(AddThreadInput {
                path: "b.go".into(),
                line: 1,
                body: "feature".into(),
                ..Default::default()
            })
            .unwrap();

        let threads = store.list().unwrap();
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].path, "b.go");
    }

    #[test]
    fn delete_and_update_are_branch_scoped_and_persist_branch() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();
        let thread = store
            .add_thread(AddThreadInput {
                path: "a.go".into(),
                line: 1,
                body: "main".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(thread.branch, "main");

        // From another branch the thread is invisible: mutations and deletes
        // must not touch a different branch's threads.
        run_git(dir.path(), &["checkout", "-b", "feature/comments"]);
        assert!(matches!(
            store.delete(&thread.id).unwrap_err(),
            CommentError::NotFound
        ));
        assert!(matches!(
            store.resolve(&thread.id).unwrap_err(),
            CommentError::NotFound
        ));

        // Back on the original branch it is intact and still scoped to "main".
        // `main` is unborn here (no commit), so re-point HEAD via symbolic-ref;
        // `checkout` would fail on a ref that never existed.
        run_git(dir.path(), &["symbolic-ref", "HEAD", "refs/heads/main"]);
        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, thread.id);

        // The branch must be stamped on the persisted record (guards the
        // under-lock stamping in add_thread against a revert to branch:"").
        let raw = fs::read_to_string(store.path()).unwrap();
        assert!(raw.contains("\"branch\": \"main\""), "{raw}");
        assert!(!raw.contains("\"branch\": \"\""), "{raw}");
    }

    #[test]
    fn store_returns_not_found_for_other_branch() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();
        let thread = store
            .add_thread(AddThreadInput {
                path: "a.go".into(),
                line: 1,
                body: "main".into(),
                ..Default::default()
            })
            .unwrap();

        run_git(dir.path(), &["checkout", "-b", "feature/comments"]);
        let err = store.resolve(&thread.id).unwrap_err();
        assert!(matches!(err, CommentError::NotFound));
    }

    #[test]
    fn store_keeps_concurrent_adds() {
        let dir = new_repo();
        let store = std::sync::Arc::new(Store::new(dir.path()).unwrap());
        const COUNT: usize = 20;
        std::thread::scope(|scope| {
            for i in 0..COUNT {
                let store = store.clone();
                scope.spawn(move || {
                    store
                        .add_thread(AddThreadInput {
                            path: format!("file-{i:02}.go"),
                            line: 1,
                            body: "body".into(),
                            ..Default::default()
                        })
                        .unwrap();
                });
            }
        });
        assert_eq!(store.list().unwrap().len(), COUNT);
    }

    #[test]
    fn add_thread_uses_explicit_author_over_git_config() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();
        let thread = store
            .add_thread(AddThreadInput {
                path: "a.go".into(),
                line: 1,
                body: "b".into(),
                author: "  carol  ".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(thread.comments[0].author, "carol");
    }

    #[test]
    fn thread_timestamps_round_trip_through_disk() {
        let dir = new_repo();
        let store = Store::new(dir.path()).unwrap();
        let created = store
            .add_thread(AddThreadInput {
                path: "a.go".into(),
                line: 1,
                body: "b".into(),
                ..Default::default()
            })
            .unwrap();

        // Re-open the store and reload from disk: timestamps must survive the
        // JSON (RFC3339) serialize/parse cycle exactly.
        let reloaded = Store::new(dir.path()).unwrap().list().unwrap();
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].created_at, created.created_at);
        assert_eq!(reloaded[0].updated_at, created.updated_at);
        assert_eq!(reloaded[0].id, created.id);

        // And a struct -> JSON -> struct round-trip is lossless.
        let json = serde_json::to_string(&created).unwrap();
        let back: Thread = serde_json::from_str(&json).unwrap();
        assert_eq!(back.created_at, created.created_at);
    }
}
