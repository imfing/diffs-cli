use crate::{comments, git};
use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};
use tokio::process::Command;
use url::Url;

pub const DEFAULT_GITHUB_HOST: &str = "github.com";
pub const DEFAULT_GH_TIMEOUT: Duration = Duration::from_secs(10);
const GH_PATCH_TIMEOUT: Duration = Duration::from_secs(90);
const GH_COMMENTS_TIMEOUT: Duration = Duration::from_secs(30);
const GITHUB_DIFF_MEDIA: &str = "application/vnd.github.v3.diff";

#[derive(Debug, Clone)]
pub struct PrTarget {
    pub path: String,
    pub host: String,
}

#[derive(Debug, Clone)]
pub struct RemoteRepo {
    pub host: String,
    pub owner: String,
    pub name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestInfo {
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub merged: bool,
    pub author: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub additions: i64,
    pub deletions: i64,
    pub changed_files: i64,
    pub commits: i64,
    pub head_ref: String,
    pub head_label: String,
    pub head_repo: String,
    pub base_ref: String,
    pub base_label: String,
    pub base_repo: String,
}

#[derive(Debug, Deserialize)]
struct PullApiResponse {
    title: String,
    state: String,
    draft: bool,
    merged: bool,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
    additions: i64,
    deletions: i64,
    changed_files: i64,
    commits: i64,
    user: Option<Author>,
    head: PullRef,
    base: PullRef,
}

#[derive(Debug, Deserialize)]
struct PullRef {
    #[serde(rename = "ref")]
    ref_name: String,
    label: String,
    repo: Option<RepoName>,
    #[serde(default)]
    sha: String,
}

#[derive(Debug, Deserialize)]
struct RepoName {
    full_name: String,
}

#[derive(Debug, Deserialize)]
struct Author {
    login: String,
}

pub async fn run(dir: impl AsRef<Path>, args: &[&str]) -> anyhow::Result<String> {
    let output = tokio::time::timeout(
        DEFAULT_GH_TIMEOUT,
        Command::new("gh").args(args).current_dir(dir).output(),
    )
    .await
    .context("gh timed out")??;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            bail!("gh failed");
        }
        bail!("{stderr}");
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub async fn run_bytes(label: &str, args: &[String], timeout: Duration) -> anyhow::Result<Vec<u8>> {
    let output = tokio::time::timeout(timeout, Command::new("gh").args(args).output())
        .await
        .with_context(|| format!("{label} timed out"))??;
    if output.status.success() {
        return Ok(output.stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        bail!("{label} failed");
    }
    bail!("{label} failed: {stderr}");
}

pub async fn current_branch_pr_url(dir: impl AsRef<Path>) -> anyhow::Result<String> {
    let url = run(dir, &["pr", "view", "--json", "url", "-q", ".url"])
        .await
        .context("resolve PR for current branch")?;
    if url.is_empty() {
        bail!("no pull request found for the current branch");
    }
    Ok(url)
}

pub async fn pr_target_from_args(
    args: &[String],
    dir: impl AsRef<Path>,
) -> anyhow::Result<PrTarget> {
    if args.is_empty() {
        let url = current_branch_pr_url(dir).await?;
        return parse_pr_target(&url);
    }
    if let Some(number) = pr_number(args) {
        let remote = git::remote_url(dir, "origin")
            .with_context(|| format!("resolve current repository for PR #{number}"))?;
        let repo = repo_from_remote_url(&remote)
            .with_context(|| format!("resolve current repository for PR #{number}"))?;
        return Ok(PrTarget {
            path: format!("/{}/{}/pull/{number}", repo.owner, repo.name),
            host: repo.host,
        });
    }
    parse_pr_target(&args[0])
}

pub fn parse_pr_target(target: &str) -> anyhow::Result<PrTarget> {
    let mut target = target.trim().to_string();
    if target.is_empty() {
        bail!("expected one GitHub PR target");
    }
    let mut host = String::new();
    let lower = target.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        let url = Url::parse(&target)?;
        host = url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("target URL must include a host"))?
            .to_lowercase();
        target = url.path().to_string();
    }
    if !target.starts_with('/') {
        target = format!("/{target}");
    }
    let parts: Vec<&str> = target.trim_matches('/').split('/').collect();
    if parts.len() >= 4
        && parts[2] == "pull"
        && !parts[3].is_empty()
        && (parts.len() == 4 || is_pull_request_subpage(&parts[4..]))
    {
        return Ok(PrTarget {
            path: format!("/{}/{}/pull/{}", parts[0], parts[1], parts[3]),
            host,
        });
    }
    bail!("target must be a GitHub PR URL or /org/repo/pull/123")
}

fn pr_number(args: &[String]) -> Option<String> {
    if args.len() != 1 {
        return None;
    }
    let value = args[0].trim();
    value
        .parse::<u64>()
        .ok()
        .filter(|number| *number > 0)
        .map(|_| value.to_string())
}

pub fn repo_from_remote_url(remote: &str) -> anyhow::Result<RemoteRepo> {
    let remote = remote.trim();
    if remote.is_empty() {
        bail!("origin remote URL is empty");
    }
    let (host, path) = if remote.contains("://") {
        let url = Url::parse(remote)?;
        let host = url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("origin remote URL must include a host"))?
            .to_lowercase();
        (host, url.path().to_string())
    } else {
        let (user_host, path) = remote.split_once(':').ok_or_else(|| {
            anyhow::anyhow!("origin remote URL must be an absolute URL or SCP-style remote")
        })?;
        if user_host.contains('/') {
            bail!("origin remote URL must be an absolute URL or SCP-style remote");
        }
        let host = user_host
            .split_once('@')
            .map(|(_, host)| host)
            .unwrap_or(user_host)
            .to_lowercase();
        (host, path.to_string())
    };
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    if parts.len() < 2 {
        bail!("origin remote URL must include owner and repository");
    }
    let name = parts[1].trim_end_matches(".git");
    if parts[0].is_empty() || name.is_empty() {
        bail!("origin remote URL must include owner and repository");
    }
    Ok(RemoteRepo {
        host,
        owner: parts[0].to_string(),
        name: name.to_string(),
    })
}

fn is_pull_request_subpage(parts: &[&str]) -> bool {
    matches!(parts, ["checks" | "commits" | "files" | "reviews"])
}

pub async fn pull_request_patch(
    github_host: &str,
    org: &str,
    repo: &str,
    number: &str,
) -> anyhow::Result<String> {
    let args = vec![
        "api".to_string(),
        format!("repos/{org}/{repo}/pulls/{number}"),
        "--hostname".to_string(),
        github_host.to_string(),
        "-H".to_string(),
        format!("Accept: {GITHUB_DIFF_MEDIA}"),
    ];
    Ok(String::from_utf8(
        run_bytes("gh api", &args, GH_PATCH_TIMEOUT).await?,
    )?)
}

async fn fetch_pull(
    github_host: &str,
    org: &str,
    repo: &str,
    number: &str,
) -> anyhow::Result<PullApiResponse> {
    let args = vec![
        "api".to_string(),
        format!("repos/{org}/{repo}/pulls/{number}"),
        "--hostname".to_string(),
        github_host.to_string(),
    ];
    Ok(serde_json::from_slice(
        &run_bytes("gh api pull request", &args, GH_COMMENTS_TIMEOUT).await?,
    )?)
}

async fn pull_request_head_sha(
    github_host: &str,
    org: &str,
    repo: &str,
    number: &str,
) -> anyhow::Result<String> {
    let sha = fetch_pull(github_host, org, repo, number).await?.head.sha;
    if sha.is_empty() {
        bail!("pull request head sha is missing");
    }
    Ok(sha)
}

pub async fn pull_request_info(
    github_host: &str,
    org: &str,
    repo: &str,
    number: &str,
) -> anyhow::Result<PullRequestInfo> {
    let response = fetch_pull(github_host, org, repo, number).await?;
    Ok(PullRequestInfo {
        title: response.title,
        state: response.state,
        draft: response.draft,
        merged: response.merged,
        author: response.user.map(|user| user.login).unwrap_or_default(),
        created_at: response.created_at,
        updated_at: response.updated_at,
        additions: response.additions,
        deletions: response.deletions,
        changed_files: response.changed_files,
        commits: response.commits,
        head_ref: response.head.ref_name,
        head_label: response.head.label,
        head_repo: response
            .head
            .repo
            .map(|repo| repo.full_name)
            .unwrap_or_default(),
        base_ref: response.base.ref_name,
        base_label: response.base.label,
        base_repo: response
            .base
            .repo
            .map(|repo| repo.full_name)
            .unwrap_or_default(),
    })
}

fn github_side(side: &str) -> &str {
    match side {
        "deletions" => "LEFT",
        _ => "RIGHT",
    }
}

fn comment_side(side: &str) -> &str {
    match side {
        "RIGHT" => "additions",
        "LEFT" => "deletions",
        _ => "",
    }
}

// --- GitHub review-thread CRUD ---

// GitHub's GraphQL API returns `null` for fields like `line`, `path`, and
// `endCursor` (e.g. outdated or file-level threads). serde errors unless we
// coalesce those nulls here.
fn null_to_default<'de, D, T>(deserializer: D) -> std::result::Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Deserialize)]
struct ReviewThreadsResponse {
    #[serde(default)]
    data: ReviewThreadsData,
}

#[derive(Debug, Default, Deserialize)]
struct ReviewThreadsData {
    #[serde(default)]
    repository: RepositoryNode,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryNode {
    #[serde(default)]
    pull_request: PullRequestNode,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestNode {
    #[serde(default)]
    review_threads: ReviewThreadsConn,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewThreadsConn {
    #[serde(default)]
    nodes: Vec<ReviewThread>,
    #[serde(default)]
    page_info: PageInfo,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    #[serde(default)]
    has_next_page: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    end_cursor: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewThread {
    #[serde(default, deserialize_with = "null_to_default")]
    id: String,
    #[serde(default)]
    is_resolved: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    path: String,
    #[serde(default, deserialize_with = "null_to_default")]
    line: i64,
    #[serde(default, deserialize_with = "null_to_default")]
    diff_side: String,
    #[serde(default, deserialize_with = "null_to_default")]
    start_line: i64,
    #[serde(default, deserialize_with = "null_to_default")]
    start_diff_side: String,
    #[serde(default)]
    comments: ReviewCommentsConn,
}

#[derive(Debug, Default, Deserialize)]
struct ReviewCommentsConn {
    #[serde(default)]
    nodes: Vec<ReviewComment>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewComment {
    #[serde(default, deserialize_with = "null_to_default")]
    id: String,
    #[serde(default, deserialize_with = "null_to_default")]
    database_id: i64,
    author: Option<Author>,
    #[serde(default, deserialize_with = "null_to_default")]
    body: String,
    #[serde(default, deserialize_with = "null_to_default")]
    url: String,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
struct CreatedComment {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    node_id: String,
}

pub async fn list_pull_request_comments(
    github_host: &str,
    org: &str,
    repo: &str,
    number: &str,
) -> anyhow::Result<Vec<comments::Thread>> {
    let mut threads = Vec::new();
    let mut cursor = String::new();
    loop {
        let mut args = vec![
            "api".to_string(),
            "graphql".to_string(),
            "--hostname".to_string(),
            github_host.to_string(),
            "-f".to_string(),
            format!("query={REVIEW_THREADS_QUERY}"),
            "-F".to_string(),
            format!("owner={org}"),
            "-F".to_string(),
            format!("name={repo}"),
            "-F".to_string(),
            format!("number={number}"),
        ];
        if !cursor.is_empty() {
            args.push("-F".to_string());
            args.push(format!("cursor={cursor}"));
        }
        let out = run_bytes("gh api graphql", &args, GH_COMMENTS_TIMEOUT).await?;
        let response: ReviewThreadsResponse = serde_json::from_slice(&out)?;
        let page = response.data.repository.pull_request.review_threads;
        for thread in page.nodes {
            if let Some(converted) = convert_github_thread(thread) {
                threads.push(converted);
            }
        }
        if !page.page_info.has_next_page || page.page_info.end_cursor.is_empty() {
            return Ok(threads);
        }
        cursor = page.page_info.end_cursor;
    }
}

async fn find_pull_request_thread(
    github_host: &str,
    org: &str,
    repo: &str,
    number: &str,
    matches: impl Fn(&comments::Thread) -> bool,
) -> anyhow::Result<comments::Thread> {
    let threads = list_pull_request_comments(github_host, org, repo, number).await?;
    threads
        .into_iter()
        .find(|thread| matches(thread))
        .ok_or_else(|| anyhow::anyhow!("comment thread not found"))
}

pub async fn add_pull_request_comment(
    github_host: &str,
    org: &str,
    repo: &str,
    number: &str,
    input: comments::AddThreadInput,
) -> anyhow::Result<comments::Thread> {
    let clean = comments::clean_thread_input(input)?;
    let sha = pull_request_head_sha(github_host, org, repo, number).await?;

    let mut args = vec![
        "api".to_string(),
        "-X".to_string(),
        "POST".to_string(),
        format!("repos/{org}/{repo}/pulls/{number}/comments"),
        "--hostname".to_string(),
        github_host.to_string(),
        "--raw-field".to_string(),
        format!("body={}", clean.body),
        "--raw-field".to_string(),
        format!("commit_id={sha}"),
        "--raw-field".to_string(),
        format!("path={}", clean.path),
        "--raw-field".to_string(),
        format!("side={}", github_side(&clean.end_side)),
        "--field".to_string(),
        format!("line={}", clean.end_line),
    ];
    if clean.end_line != clean.line || clean.end_side != clean.side {
        args.push("--field".to_string());
        args.push(format!("start_line={}", clean.line));
        args.push("--raw-field".to_string());
        args.push(format!("start_side={}", github_side(&clean.side)));
    }
    let out = run_bytes(
        "gh api create pull request comment",
        &args,
        GH_COMMENTS_TIMEOUT,
    )
    .await?;
    let created: CreatedComment = serde_json::from_slice(&out)?;
    let created_db = created.id.to_string();
    find_pull_request_thread(github_host, org, repo, number, |thread| {
        thread.comments.iter().any(|comment| {
            comment.id == created.node_id || (created.id != 0 && comment.id == created_db)
        })
    })
    .await
}

pub async fn add_pull_request_reply(
    github_host: &str,
    org: &str,
    repo: &str,
    number: &str,
    thread_id: &str,
    input: comments::AddReplyInput,
) -> anyhow::Result<comments::Thread> {
    let body = input.body.trim().to_string();
    if body.is_empty() {
        bail!("body is required");
    }
    let thread =
        find_pull_request_thread(github_host, org, repo, number, |t| t.id == thread_id).await?;
    let reply_to = thread
        .reply_to_id
        .filter(|id| *id != 0)
        .ok_or_else(|| anyhow::anyhow!("pull request thread has no reply target"))?;

    let args = vec![
        "api".to_string(),
        "-X".to_string(),
        "POST".to_string(),
        format!("repos/{org}/{repo}/pulls/{number}/comments/{reply_to}/replies"),
        "--hostname".to_string(),
        github_host.to_string(),
        "--raw-field".to_string(),
        format!("body={body}"),
    ];
    run_bytes(
        "gh api create pull request comment reply",
        &args,
        GH_COMMENTS_TIMEOUT,
    )
    .await?;
    find_pull_request_thread(github_host, org, repo, number, |t| t.id == thread_id).await
}

pub async fn set_pull_request_thread_resolved(
    github_host: &str,
    org: &str,
    repo: &str,
    number: &str,
    thread_id: &str,
    resolved: bool,
) -> anyhow::Result<comments::Thread> {
    let (mutation, label) = if resolved {
        (
            RESOLVE_REVIEW_THREAD_MUTATION,
            "gh api resolve review thread",
        )
    } else {
        (
            UNRESOLVE_REVIEW_THREAD_MUTATION,
            "gh api unresolve review thread",
        )
    };
    let args = vec![
        "api".to_string(),
        "graphql".to_string(),
        "--hostname".to_string(),
        github_host.to_string(),
        "-f".to_string(),
        format!("query={mutation}"),
        "-F".to_string(),
        format!("threadID={thread_id}"),
    ];
    run_bytes(label, &args, GH_COMMENTS_TIMEOUT).await?;
    find_pull_request_thread(github_host, org, repo, number, |t| t.id == thread_id).await
}

fn convert_github_thread(thread: ReviewThread) -> Option<comments::Thread> {
    if thread.id.is_empty() || thread.comments.nodes.is_empty() {
        return None;
    }
    let first = &thread.comments.nodes[0];
    let last = &thread.comments.nodes[thread.comments.nodes.len() - 1];

    let mut line = thread.line;
    if thread.start_line > 0 {
        line = thread.start_line;
    }
    if thread.path.is_empty() || line < 1 {
        return None;
    }

    let mut side = comment_side(&thread.start_diff_side);
    if side.is_empty() {
        side = comment_side(&thread.diff_side);
    }
    if side.is_empty() {
        side = comments::DEFAULT_SIDE;
    }

    let mut end_line = thread.line;
    if end_line == 0 {
        end_line = line;
    }
    let mut end_side = comment_side(&thread.diff_side);
    if end_side.is_empty() {
        end_side = side;
    }

    let status = if thread.is_resolved {
        "resolved"
    } else {
        "open"
    };
    let reply_to_id = (first.database_id != 0).then_some(first.database_id);

    let mut converted = comments::Thread {
        id: thread.id,
        provider: "github".to_string(),
        branch: String::new(),
        path: thread.path,
        side: side.to_string(),
        line: line as u32,
        end_side: String::new(),
        end_line: 0,
        status: status.to_string(),
        created_at: first.created_at,
        updated_at: last.created_at,
        comments: thread
            .comments
            .nodes
            .iter()
            .map(|comment| comments::Comment {
                id: comment_id(comment),
                author: comment_author(comment),
                body: comment.body.clone(),
                created_at: comment.created_at,
            })
            .collect(),
        reply_to_id,
        url: first.url.clone(),
    };
    if end_line != line || end_side != side {
        converted.end_side = end_side.to_string();
        converted.end_line = end_line as u32;
    }
    Some(converted)
}

fn comment_id(comment: &ReviewComment) -> String {
    if !comment.id.is_empty() {
        return comment.id.clone();
    }
    if comment.database_id != 0 {
        return comment.database_id.to_string();
    }
    String::new()
}

fn comment_author(comment: &ReviewComment) -> String {
    match &comment.author {
        Some(author) if !author.login.is_empty() => author.login.clone(),
        _ => "github".to_string(),
    }
}

const REVIEW_THREADS_QUERY: &str = r#"
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          path
          line
          diffSide
          startLine
          startDiffSide
          comments(first: 100) {
            nodes {
              id
              databaseId
              author {
                login
              }
              body
              url
              createdAt
            }
          }
        }
      }
    }
  }
}"#;

const RESOLVE_REVIEW_THREAD_MUTATION: &str = r#"
mutation($threadID: ID!) {
  resolveReviewThread(input: {threadId: $threadID}) {
    thread {
      id
      isResolved
    }
  }
}"#;

const UNRESOLVE_REVIEW_THREAD_MUTATION: &str = r#"
mutation($threadID: ID!) {
  unresolveReviewThread(input: {threadId: $threadID}) {
    thread {
      id
      isResolved
    }
  }
}"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_pr_target_paths_and_hosts() {
        // (input, want_path, want_host)
        let cases = [
            ("/org/repo/pull/123", "/org/repo/pull/123", ""),
            ("org/repo/pull/123", "/org/repo/pull/123", ""),
            (
                "https://github.com/org/repo/pull/123",
                "/org/repo/pull/123",
                "github.com",
            ),
            (
                "https://github.example.com:8443/org/repo/pull/123",
                "/org/repo/pull/123",
                "github.example.com",
            ),
            (
                "https://GITHUB.example.com/org/repo/pull/123",
                "/org/repo/pull/123",
                "github.example.com",
            ),
            (
                "HTTPS://github.example.com/org/repo/pull/123",
                "/org/repo/pull/123",
                "github.example.com",
            ),
            (
                "https://github.example.com/org/repo/pull/123/files",
                "/org/repo/pull/123",
                "github.example.com",
            ),
            (
                "https://github.example.com/org/repo/pull/123/commits",
                "/org/repo/pull/123",
                "github.example.com",
            ),
        ];
        for (input, want_path, want_host) in cases {
            let target = parse_pr_target(input).unwrap_or_else(|e| panic!("{input}: {e}"));
            assert_eq!(target.path, want_path, "path for {input}");
            assert_eq!(target.host, want_host, "host for {input}");
        }
    }

    #[test]
    fn parse_pr_target_rejects_non_pr() {
        for input in [
            "",
            "org/repo",
            "https://github.com/org/repo",
            "/org/repo/pull/",
        ] {
            assert!(
                parse_pr_target(input).is_err(),
                "expected error for {input:?}"
            );
        }
    }

    #[test]
    fn repo_from_remote_url_variants() {
        let https = repo_from_remote_url("https://github.com/org/repo.git").unwrap();
        assert_eq!(
            (
                https.host.as_str(),
                https.owner.as_str(),
                https.name.as_str()
            ),
            ("github.com", "org", "repo")
        );

        let scp = repo_from_remote_url("git@github.com:org/repo.git").unwrap();
        assert_eq!(
            (scp.host.as_str(), scp.owner.as_str(), scp.name.as_str()),
            ("github.com", "org", "repo")
        );

        let ssh = repo_from_remote_url("ssh://git@github.example.com/org/repo.git").unwrap();
        assert_eq!(
            (ssh.host.as_str(), ssh.owner.as_str(), ssh.name.as_str()),
            ("github.example.com", "org", "repo")
        );

        assert!(repo_from_remote_url("https://github.com/org").is_err());
        assert!(repo_from_remote_url("").is_err());
    }

    #[test]
    fn pr_number_only_for_single_positive_integer() {
        assert_eq!(pr_number(&["123".to_string()]), Some("123".to_string()));
        assert_eq!(pr_number(&["0".to_string()]), None);
        assert_eq!(pr_number(&["abc".to_string()]), None);
        assert_eq!(pr_number(&["1".to_string(), "2".to_string()]), None);
        assert_eq!(pr_number(&[]), None);
    }

    #[test]
    fn side_mappings_round_trip() {
        assert_eq!(github_side("deletions"), "LEFT");
        assert_eq!(github_side("additions"), "RIGHT");
        assert_eq!(github_side("anything"), "RIGHT");
        assert_eq!(comment_side("LEFT"), "deletions");
        assert_eq!(comment_side("RIGHT"), "additions");
        assert_eq!(comment_side("?"), "");
    }

    #[test]
    fn convert_github_thread_maps_fields_and_range() {
        let created: chrono::DateTime<chrono::Utc> = "2026-05-23T12:00:00Z".parse().unwrap();
        let updated: chrono::DateTime<chrono::Utc> = "2026-05-23T13:00:00Z".parse().unwrap();
        let thread = ReviewThread {
            id: "thr1".to_string(),
            is_resolved: true,
            path: "src/app.rs".to_string(),
            line: 10,
            diff_side: "RIGHT".to_string(),
            start_line: 8,
            start_diff_side: "RIGHT".to_string(),
            comments: ReviewCommentsConn {
                nodes: vec![
                    ReviewComment {
                        id: "c1".to_string(),
                        database_id: 42,
                        author: Some(Author {
                            login: "alice".to_string(),
                        }),
                        body: "first".to_string(),
                        url: "http://example/c1".to_string(),
                        created_at: created,
                    },
                    ReviewComment {
                        id: "c2".to_string(),
                        database_id: 43,
                        author: None,
                        body: "second".to_string(),
                        url: "http://example/c2".to_string(),
                        created_at: updated,
                    },
                ],
            },
        };
        let converted = convert_github_thread(thread).expect("thread converts");
        assert_eq!(converted.id, "thr1");
        assert_eq!(converted.provider, "github");
        assert_eq!(converted.status, "resolved");
        assert_eq!(converted.line, 8); // start_line wins
        assert_eq!(converted.end_line, 10); // thread.line
        assert_eq!(converted.side, "additions");
        assert_eq!(converted.end_side, "additions");
        assert_eq!(converted.reply_to_id, Some(42));
        assert_eq!(converted.url, "http://example/c1");
        assert_eq!(converted.created_at, created);
        assert_eq!(converted.updated_at, updated);
        assert_eq!(converted.comments.len(), 2);
        assert_eq!(converted.comments[0].author, "alice");
        assert_eq!(converted.comments[1].author, "github"); // fallback
    }

    #[test]
    fn convert_github_thread_skips_empty() {
        assert!(convert_github_thread(ReviewThread::default()).is_none());
    }
}
