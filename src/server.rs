use crate::{
    comments::{self, AddReplyInput, AddThreadInput, CommentError, Store, Thread},
    config::{self, UiConfig},
    gh, git,
    webassets::Assets,
};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{delete, get, post},
};
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    net::SocketAddr,
    panic::AssertUnwindSafe,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::broadcast;
use tokio_stream::{StreamExt, wrappers::BroadcastStream};

/// Callback invoked on each debounced reload while watching, with the files
/// that changed in that batch (empty for a git-state-only change, e.g. a branch
/// switch). Used by the CLI's reload logger.
pub type OnChange = Arc<dyn Fn(Vec<git::ChangedFile>) + Send + Sync>;

#[derive(Clone)]
pub struct ServerConfig {
    pub cwd: PathBuf,
    pub github_host: String,
    pub ui: UiConfig,
    pub watch: bool,
    pub on_change: Option<OnChange>,
}

#[derive(Clone)]
struct AppState {
    cwd: PathBuf,
    github_host: String,
    ui: UiConfig,
    comments: Option<Arc<Store>>,
    events: broadcast::Sender<()>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigResponse {
    cwd: String,
    git_branch: String,
    github_host: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    color_scheme: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    diff_theme: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    diff_style: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    ui_font_family: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    code_font_family: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    word_wrap: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line_numbers: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line_backgrounds: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoContextResponse {
    #[serde(skip_serializing_if = "String::is_empty")]
    repo_url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pr_url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    branch_base: String,
}

#[derive(Debug, Deserialize)]
struct BranchDiffQuery {
    base: Option<String>,
    dirty: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CommentTargetQuery {
    org: Option<String>,
    repo: Option<String>,
    number: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BlobQuery {
    oid: Option<String>,
    path: Option<String>,
    worktree: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PullFileQuery {
    path: Option<String>,
    side: Option<String>,
}

pub struct RunningServer {
    pub router: Router,
    _watcher: Option<notify::RecommendedWatcher>,
}

pub fn new(cfg: ServerConfig) -> anyhow::Result<RunningServer> {
    let cwd = std::fs::canonicalize(if cfg.cwd.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        cfg.cwd
    })?;
    let github_host = if cfg.github_host.trim().is_empty() {
        gh::DEFAULT_GITHUB_HOST.to_string()
    } else {
        cfg.github_host.trim().to_string()
    };
    let comments = Store::new(&cwd).ok().map(Arc::new);
    let (events, _) = broadcast::channel(128);
    let watcher = if cfg.watch {
        Some(start_watcher(
            cwd.clone(),
            events.clone(),
            cfg.on_change.clone(),
        )?)
    } else {
        None
    };
    let state = AppState {
        cwd,
        github_host,
        ui: config::normalize_ui(cfg.ui),
        comments,
        events,
    };
    let router = Router::new()
        .route("/api/config", get(handle_config))
        .route("/api/events", get(handle_events))
        .route("/api/local-diff", get(handle_local_diff))
        .route("/api/branch-diff", get(handle_branch_diff))
        .route("/api/repo-context", get(handle_repo_context))
        .route(
            "/api/comments",
            get(handle_list_comments).post(handle_add_comment),
        )
        .route("/api/comments/{thread_id}", delete(handle_delete_comment))
        .route(
            "/api/comments/{thread_id}/replies",
            post(handle_reply_comment),
        )
        .route(
            "/api/comments/{thread_id}/resolve",
            post(handle_resolve_comment),
        )
        .route(
            "/api/comments/{thread_id}/reopen",
            post(handle_reopen_comment),
        )
        .route(
            "/api/pull/{org}/{repo}/{number}",
            get(handle_pull_request_info),
        )
        .route("/api/patch/{org}/{repo}/{number}", get(handle_patch))
        .route("/api/blob", get(handle_blob))
        .route(
            "/api/pull/{org}/{repo}/{number}/file",
            get(handle_pull_file),
        )
        .fallback(handle_static)
        .with_state(state);
    Ok(RunningServer {
        router,
        _watcher: watcher,
    })
}

pub async fn serve(addr: SocketAddr, cfg: ServerConfig) -> anyhow::Result<()> {
    let running = new(cfg)?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    serve_router(listener, running.router).await
}

/// Header-read timeout for incoming connections. Bounds the slow-loris window
/// where a client opens a connection but never finishes sending request headers.
const READ_HEADER_TIMEOUT: Duration = Duration::from_secs(5);

/// Serves `router` over `listener` with a per-connection header-read timeout.
///
/// `axum::serve` exposes no header-read deadline, so we drive hyper directly.
/// The timeout fires before routing; a tower request timeout would run too late
/// and would also break the long-lived SSE stream.
pub async fn serve_router(
    listener: tokio::net::TcpListener,
    router: axum::Router,
) -> anyhow::Result<()> {
    use hyper::server::conn::http1;
    use hyper_util::rt::{TokioIo, TokioTimer};
    use hyper_util::service::TowerToHyperService;

    loop {
        let (stream, _) = listener.accept().await?;
        let io = TokioIo::new(stream);
        let service = TowerToHyperService::new(router.clone());
        tokio::spawn(async move {
            let mut builder = http1::Builder::new();
            // header_read_timeout needs an explicit timer (hyper has no default).
            builder
                .timer(TokioTimer::new())
                .header_read_timeout(READ_HEADER_TIMEOUT);
            // Per-connection errors are isolated to that connection; drop them.
            // `with_upgrades` keeps the SSE stream working.
            let _ = builder.serve_connection(io, service).with_upgrades().await;
        });
    }
}

async fn handle_config(State(state): State<AppState>) -> impl IntoResponse {
    let ui = &state.ui;
    Json(ConfigResponse {
        cwd: state.cwd.to_string_lossy().to_string(),
        git_branch: git::branch(&state.cwd),
        github_host: state.github_host,
        color_scheme: valid(config::is_color_scheme, &ui.color_scheme),
        diff_theme: valid(config::is_diff_theme, &ui.diff_theme),
        diff_style: valid(config::is_diff_style, &ui.diff_style),
        ui_font_family: ui.ui_font_family.clone(),
        code_font_family: ui.code_font_family.clone(),
        word_wrap: ui.word_wrap,
        line_numbers: ui.line_numbers,
        line_backgrounds: ui.line_backgrounds,
    })
}

async fn handle_events(
    State(state): State<AppState>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>> {
    let stream = BroadcastStream::new(state.events.subscribe()).filter_map(|event| match event {
        Ok(()) => Some(Ok(Event::default().event("diff").data("{}"))),
        Err(_) => None,
    });
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(25))
            .text("ping"),
    )
}

async fn handle_local_diff(State(state): State<AppState>) -> Response {
    match git::local_diff(&state.cwd) {
        Ok(patch) => text(patch),
        Err(err) => error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn handle_branch_diff(
    State(state): State<AppState>,
    Query(query): Query<BranchDiffQuery>,
) -> Response {
    let base = query.base.unwrap_or_default().trim().to_string();
    if base.is_empty() {
        return error(StatusCode::BAD_REQUEST, "base query parameter is required");
    }
    if !is_safe_ref_arg(&base) {
        return error(
            StatusCode::BAD_REQUEST,
            format!("invalid base ref: {base:?}"),
        );
    }
    match git::branch_diff(&state.cwd, &base, dirty_enabled(query.dirty.as_deref())) {
        Ok(patch) => text(patch),
        Err(err) => error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn handle_repo_context(State(state): State<AppState>) -> impl IntoResponse {
    // The two lookups are independent; run them concurrently so the handler's
    // latency is the slower call, not the sum.
    let (pr_json, repo_json) = tokio::join!(
        gh::run(&state.cwd, &["pr", "view", "--json", "url,baseRefName"]),
        gh::run(
            &state.cwd,
            &["repo", "view", "--json", "url,defaultBranchRef"],
        ),
    );
    let pr_json = pr_json.ok();
    let repo_json = repo_json.ok();
    let pr: serde_json::Value = pr_json
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default();
    let repo: serde_json::Value = repo_json
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default();
    let branch_base = [
        pr.pointer("/baseRefName").and_then(|v| v.as_str()),
        repo.pointer("/defaultBranchRef/name")
            .and_then(|v| v.as_str()),
        Some("main"),
        Some("master"),
    ]
    .into_iter()
    .flatten()
    .find_map(|candidate| git::resolve_local_ref(&state.cwd, candidate))
    .unwrap_or_default();
    Json(RepoContextResponse {
        repo_url: repo
            .pointer("/url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        pr_url: pr
            .pointer("/url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        branch_base,
    })
}

async fn handle_list_comments(
    State(state): State<AppState>,
    Query(target): Query<CommentTargetQuery>,
) -> Response {
    match comment_scope(&target) {
        CommentScope::Invalid => invalid_pull_path(),
        CommentScope::Pull(pr) => {
            match gh::list_pull_request_comments(&state.github_host, &pr.org, &pr.repo, &pr.number)
                .await
            {
                Ok(threads) => {
                    (StatusCode::OK, Json(json!({ "threads": threads }))).into_response()
                }
                Err(err) => error(StatusCode::BAD_GATEWAY, err),
            }
        }
        CommentScope::Local => {
            let Some(store) = state.comments else {
                return comments_unavailable();
            };
            match store.list() {
                Ok(threads) => {
                    (StatusCode::OK, Json(json!({ "threads": threads }))).into_response()
                }
                Err(err) => comment_error(err),
            }
        }
    }
}

async fn handle_add_comment(
    State(state): State<AppState>,
    Query(target): Query<CommentTargetQuery>,
    Json(input): Json<AddThreadInput>,
) -> Response {
    match comment_scope(&target) {
        CommentScope::Invalid => invalid_pull_path(),
        CommentScope::Pull(pr) => {
            match gh::add_pull_request_comment(
                &state.github_host,
                &pr.org,
                &pr.repo,
                &pr.number,
                input,
            )
            .await
            {
                Ok(thread) => (StatusCode::CREATED, Json(thread)).into_response(),
                Err(err) => error(StatusCode::BAD_GATEWAY, err),
            }
        }
        CommentScope::Local => {
            let Some(store) = state.comments else {
                return comments_unavailable();
            };
            match store.add_thread(input) {
                Ok(thread) => (StatusCode::CREATED, Json(thread)).into_response(),
                Err(err) => comment_error(err),
            }
        }
    }
}

async fn handle_delete_comment(
    State(state): State<AppState>,
    Query(target): Query<CommentTargetQuery>,
    Path(thread_id): Path<String>,
) -> Response {
    match comment_scope(&target) {
        CommentScope::Invalid => invalid_pull_path(),
        CommentScope::Pull(_) => error(
            StatusCode::BAD_REQUEST,
            "deleting GitHub comments is not supported",
        ),
        CommentScope::Local => {
            let Some(store) = state.comments else {
                return comments_unavailable();
            };
            match store.delete(&thread_id) {
                Ok(()) => StatusCode::NO_CONTENT.into_response(),
                Err(err) => comment_error(err),
            }
        }
    }
}

async fn handle_reply_comment(
    State(state): State<AppState>,
    Query(target): Query<CommentTargetQuery>,
    Path(thread_id): Path<String>,
    Json(input): Json<AddReplyInput>,
) -> Response {
    match comment_scope(&target) {
        CommentScope::Invalid => invalid_pull_path(),
        CommentScope::Pull(pr) => pr_thread_response(
            gh::add_pull_request_reply(
                &state.github_host,
                &pr.org,
                &pr.repo,
                &pr.number,
                &thread_id,
                input,
            )
            .await,
        ),
        CommentScope::Local => {
            write_thread_or_error(state.comments, |store| store.add_reply(&thread_id, input))
        }
    }
}

async fn handle_resolve_comment(
    State(state): State<AppState>,
    Query(target): Query<CommentTargetQuery>,
    Path(thread_id): Path<String>,
) -> Response {
    set_resolved(state, target, thread_id, true).await
}

async fn handle_reopen_comment(
    State(state): State<AppState>,
    Query(target): Query<CommentTargetQuery>,
    Path(thread_id): Path<String>,
) -> Response {
    set_resolved(state, target, thread_id, false).await
}

async fn set_resolved(
    state: AppState,
    target: CommentTargetQuery,
    thread_id: String,
    resolved: bool,
) -> Response {
    match comment_scope(&target) {
        CommentScope::Invalid => invalid_pull_path(),
        CommentScope::Pull(pr) => pr_thread_response(
            gh::set_pull_request_thread_resolved(
                &state.github_host,
                &pr.org,
                &pr.repo,
                &pr.number,
                &thread_id,
                resolved,
            )
            .await,
        ),
        CommentScope::Local => write_thread_or_error(state.comments, |store| {
            if resolved {
                store.resolve(&thread_id)
            } else {
                store.reopen(&thread_id)
            }
        }),
    }
}

async fn handle_pull_request_info(
    State(state): State<AppState>,
    Path((org, repo, number)): Path<(String, String, String)>,
) -> Response {
    if let Err(err) = validate_pr_path(&org, &repo, &number) {
        return error(StatusCode::BAD_REQUEST, err);
    }
    match gh::pull_request_info(&state.github_host, &org, &repo, &number).await {
        Ok(info) => (StatusCode::OK, Json(info)).into_response(),
        Err(err) => error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn handle_patch(
    State(state): State<AppState>,
    Path((org, repo, number)): Path<(String, String, String)>,
) -> Response {
    if let Err(err) = validate_pr_path(&org, &repo, &number) {
        return error(StatusCode::BAD_REQUEST, err);
    }
    match gh::pull_request_patch(&state.github_host, &org, &repo, &number).await {
        Ok(patch) => text(patch),
        Err(err) => error(StatusCode::BAD_GATEWAY, err),
    }
}

/// Serves either a repository blob by object id (`?oid=`) or a working-tree
/// file by repo-relative path (`?path=&worktree=1`), for `loadDiffFiles`
/// hydration of local/branch diffs. The two forms are mutually exclusive.
async fn handle_blob(State(state): State<AppState>, Query(query): Query<BlobQuery>) -> Response {
    let oid = query.oid.as_deref().unwrap_or_default().trim();
    let path = query.path.as_deref().unwrap_or_default().trim();
    if oid.is_empty() && path.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "oid or path query parameter is required",
        );
    }
    if !oid.is_empty() && !path.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "oid and path are mutually exclusive",
        );
    }
    let result = if !oid.is_empty() {
        git::read_blob(&state.cwd, oid)
    } else if dirty_enabled(query.worktree.as_deref()) {
        git::read_worktree_file(&state.cwd, path)
    } else {
        return error(StatusCode::BAD_REQUEST, "path requires worktree=1");
    };
    match result {
        Ok(bytes) => blob_response(bytes),
        Err(err) => blob_error(err),
    }
}

/// Fetches a single file's raw content from one side of a pull request, for
/// `loadDiffFiles` hydration of PR diffs.
async fn handle_pull_file(
    State(state): State<AppState>,
    Path((org, repo, number)): Path<(String, String, String)>,
    Query(query): Query<PullFileQuery>,
) -> Response {
    if let Err(err) = validate_pr_path(&org, &repo, &number) {
        return error(StatusCode::BAD_REQUEST, err);
    }
    let path = query.path.as_deref().unwrap_or_default().trim();
    if !git::is_safe_repo_path(path) {
        return error(StatusCode::BAD_REQUEST, "invalid path query parameter");
    }
    let side = query.side.as_deref().unwrap_or_default().trim();
    if side != "old" && side != "new" {
        return error(StatusCode::BAD_REQUEST, "side must be old or new");
    }
    match gh::pull_request_file(&state.github_host, &org, &repo, &number, path, side).await {
        Ok(bytes) => blob_response(bytes),
        Err(err) => error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn handle_static(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let (asset_path, asset) = match Assets::get(path) {
        Some(asset) => (path, asset),
        None => match Assets::get("index.html") {
            Some(asset) => ("index.html", asset),
            None => {
                return error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "index.html not found in web assets",
                );
            }
        },
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_for(asset_path))
        .body(Body::from(asset.data.into_owned()))
        .unwrap()
}

fn write_thread_or_error(
    store: Option<Arc<Store>>,
    f: impl FnOnce(&Store) -> comments::Result<Thread>,
) -> Response {
    let Some(store) = store else {
        return comments_unavailable();
    };
    match f(&store) {
        Ok(thread) => (StatusCode::OK, Json(thread)).into_response(),
        Err(err) => comment_error(err),
    }
}

fn comment_error(err: CommentError) -> Response {
    match err {
        CommentError::NotFound => error(StatusCode::NOT_FOUND, err),
        CommentError::Validation(_) => error(StatusCode::BAD_REQUEST, err),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

fn text(patch: String) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(patch))
        .unwrap()
}

fn error(status: StatusCode, err: impl std::fmt::Display) -> Response {
    (status, Json(json!({ "error": err.to_string() }))).into_response()
}

/// Cap on hydrated file contents (blob or PR file): large enough for any
/// source file worth diffing, small enough to bound memory for one request.
const MAX_BLOB_BYTES: usize = 5 * 1024 * 1024;

/// Renders raw file bytes for `loadDiffFiles` hydration: rejects oversized
/// content (413) and binary content, detected via an embedded NUL byte (415),
/// otherwise decodes as UTF-8 (lossily, for non-UTF-8 text).
fn blob_response(bytes: Vec<u8>) -> Response {
    if bytes.len() > MAX_BLOB_BYTES {
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file is too large to hydrate",
        );
    }
    if bytes.contains(&0) {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "binary file cannot be hydrated",
        );
    }
    text(String::from_utf8_lossy(&bytes).into_owned())
}

fn blob_error(err: git::GitError) -> Response {
    match err {
        git::GitError::InvalidOid | git::GitError::InvalidRepoPath => {
            error(StatusCode::BAD_REQUEST, err)
        }
        _ => error(StatusCode::NOT_FOUND, err),
    }
}

fn valid(check: impl Fn(&str) -> bool, value: &str) -> String {
    if check(value) {
        value.to_string()
    } else {
        String::new()
    }
}

fn dirty_enabled(value: Option<&str>) -> bool {
    let value = value.unwrap_or_default().trim();
    ["1", "true", "yes", "on"]
        .iter()
        .any(|candidate| value.eq_ignore_ascii_case(candidate))
}

fn is_safe_ref_arg(ref_name: &str) -> bool {
    if ref_name.is_empty()
        || ref_name.starts_with('-')
        || ref_name.contains("..")
        || ref_name.contains('~')
        || ref_name.contains('^')
        || ref_name == "@"
        || ref_name.contains('{')
        || ref_name.contains('}')
        || ref_name.contains('\\')
    {
        return false;
    }
    !ref_name
        .chars()
        .any(|c| c <= ' ' || c == '\u{7f}' || matches!(c, ':' | '?' | '*' | '['))
}

struct PullTarget {
    org: String,
    repo: String,
    number: String,
}

enum CommentScope {
    Local,
    Pull(PullTarget),
    Invalid,
}

/// Empty org/repo/number means local comments; otherwise the trio must pass the
/// same validators as the PR routes, or the request is rejected with 400
/// (`Invalid`).
fn comment_scope(target: &CommentTargetQuery) -> CommentScope {
    let org = target.org.as_deref().unwrap_or_default();
    let repo = target.repo.as_deref().unwrap_or_default();
    let number = target.number.as_deref().unwrap_or_default();
    if org.is_empty() && repo.is_empty() && number.is_empty() {
        return CommentScope::Local;
    }
    if safe_path_part(org) && safe_path_part(repo) && pull_number(number) {
        CommentScope::Pull(PullTarget {
            org: org.to_string(),
            repo: repo.to_string(),
            number: number.to_string(),
        })
    } else {
        CommentScope::Invalid
    }
}

fn invalid_pull_path() -> Response {
    error(StatusCode::BAD_REQUEST, "invalid pull request path")
}

fn comments_unavailable() -> Response {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "local comments require a git repository",
    )
}

fn pr_thread_response(result: anyhow::Result<Thread>) -> Response {
    match result {
        Ok(thread) => (StatusCode::OK, Json(thread)).into_response(),
        Err(err) => error(StatusCode::BAD_GATEWAY, err),
    }
}

fn validate_pr_path(org: &str, repo: &str, number: &str) -> anyhow::Result<()> {
    if safe_path_part(org) && safe_path_part(repo) && pull_number(number) {
        Ok(())
    } else {
        anyhow::bail!("invalid pull request path")
    }
}

fn pull_number(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) && !value.starts_with('0')
}

fn safe_path_part(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && !value.contains("..")
        && !value.contains('/')
        && !value.contains('\\')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn mime_for(path: &str) -> &'static str {
    match FsPath::new(path).extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("map") => "application/json; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("webp") => "image/webp",
        Some("wasm") => "application/wasm",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        _ => "application/octet-stream",
    }
}

const WATCH_DEBOUNCE: Duration = Duration::from_millis(150);

// Git-internal files whose changes mean the repository state moved (branch
// switch, commit, stage).
const GIT_STATE_ENTRIES: [&str; 8] = [
    "HEAD",
    "index",
    "index.lock",
    "packed-refs",
    "packed-refs.lock",
    "refs",
    "logs",
    "COMMIT_EDITMSG",
];

/// One debounced batch of filesystem activity.
struct WatchTick {
    /// A watched `.git` state file changed (branch switch, commit, stage).
    git_state: bool,
    /// Repository-relative, forward-slash paths of relevant (non-ignored) changes.
    paths: Vec<String>,
}

fn start_watcher(
    cwd: PathBuf,
    events: broadcast::Sender<()>,
    on_change: Option<OnChange>,
) -> anyhow::Result<notify::RecommendedWatcher> {
    use std::sync::mpsc::{self, RecvTimeoutError};

    // notify invokes the event handler on its own (non-tokio) thread, so the
    // handler only classifies paths and forwards a tick over a sync channel. A
    // dedicated debounce thread coalesces bursts and resolves the changed files
    // 150ms after the last event.
    let (tx, rx) = mpsc::channel::<WatchTick>();
    let status_cwd = cwd.clone();
    std::thread::spawn(move || {
        // Repository handle for `git status` lookups; lives only on this thread.
        let repo = git::discover(&status_cwd).ok();
        loop {
            let mut pending: BTreeSet<String> = BTreeSet::new();
            let mut git_state = false;
            match rx.recv() {
                Ok(tick) => merge_tick(&mut pending, &mut git_state, tick),
                Err(_) => return, // watcher dropped
            }
            loop {
                match rx.recv_timeout(WATCH_DEBOUNCE) {
                    Ok(tick) => merge_tick(&mut pending, &mut git_state, tick),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }

            // Resolve which of the changed paths git actually reports, then
            // broadcast only when the effective repository state changed.
            let status = repo.as_ref().and_then(|repo| git::status_map(repo).ok());
            let changed = match &status {
                Some(map) => changed_files_for_events(&pending, map),
                None => changed_files_from_events(&pending),
            };
            let broadcast = !changed.is_empty() || git_state;
            if broadcast {
                let _ = events.send(());
                if let Some(on_change) = &on_change {
                    // Isolate the callback: a panic here (e.g. println! on a
                    // broken stdout pipe) must not unwind and kill this thread,
                    // which would silently stop all future SSE broadcasts.
                    let _ = std::panic::catch_unwind(AssertUnwindSafe(|| on_change(changed)));
                }
            }
        }
    });

    // A dedicated repo handle for ignore lookups on notify's handler thread.
    // git2::Repository is Send but not Sync; single-threaded access here is sound.
    let repo = git::discover(&cwd).ok();
    let git_dir = repo.as_ref().map(|repo| repo.path().to_path_buf());
    // Kept for the external-git-dir watch below (the closure moves `git_dir`).
    let external_git_dir = git_dir.clone().filter(|dir| !dir.starts_with(&cwd));
    let event_cwd = cwd.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else {
            return;
        };
        let mut tick = WatchTick {
            git_state: false,
            paths: Vec::new(),
        };
        for path in &event.paths {
            // Git-state files take priority (checked before the .git skip below).
            if git_dir
                .as_deref()
                .is_some_and(|git_dir| is_git_state_file(git_dir, path))
            {
                tick.git_state = true;
                continue;
            }
            // Skip VCS/temp files and gitignored paths: they never reach the diff.
            if is_structurally_ignored(path)
                || repo
                    .as_ref()
                    .is_some_and(|repo| git::is_path_ignored(repo, path))
            {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(&event_cwd) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                if !rel.is_empty() {
                    tick.paths.push(rel);
                }
            }
        }
        if tick.git_state || !tick.paths.is_empty() {
            let _ = tx.send(tick);
        }
    })?;
    watcher.watch(&cwd, RecursiveMode::Recursive)?;
    // For linked worktrees and submodules the git dir lives outside the working
    // tree, so the recursive cwd watch never sees its HEAD/index/refs changes.
    // Watch it explicitly (best-effort; only git-state refreshes depend on it).
    if let Some(git_dir) = external_git_dir {
        let _ = watcher.watch(&git_dir, RecursiveMode::Recursive);
    }
    Ok(watcher)
}

fn merge_tick(pending: &mut BTreeSet<String>, git_state: &mut bool, tick: WatchTick) {
    if tick.git_state {
        *git_state = true;
    }
    pending.extend(tick.paths);
}

/// Whether `path` is a watched `.git` state file (relative to the git dir).
fn is_git_state_file(git_dir: &FsPath, path: &FsPath) -> bool {
    let Ok(rel) = path.strip_prefix(git_dir) else {
        return false;
    };
    match rel.components().next() {
        None => true, // the git dir itself
        Some(std::path::Component::Normal(first)) => first
            .to_str()
            .is_some_and(|name| GIT_STATE_ENTRIES.contains(&name)),
        _ => false,
    }
}

/// Intersects the changed event paths with git's reported status: an event path
/// matches directly, or matches every status entry beneath it when the event was
/// on a directory.
fn changed_files_for_events(
    events: &BTreeSet<String>,
    status: &BTreeMap<String, git::ChangeAction>,
) -> Vec<git::ChangedFile> {
    if events.is_empty() || status.is_empty() {
        return Vec::new();
    }
    let mut matches: BTreeMap<String, git::ChangeAction> = BTreeMap::new();
    for event in events {
        let event = event.trim_matches('/');
        if event.is_empty() {
            continue;
        }
        if let Some(action) = status.get(event) {
            matches.insert(event.to_string(), *action);
            continue;
        }
        let prefix = format!("{event}/");
        for (path, action) in status {
            if path.starts_with(&prefix) {
                matches.insert(path.clone(), *action);
            }
        }
    }
    matches
        .into_iter()
        .map(|(path, action)| git::ChangedFile { path, action })
        .collect()
}

/// Fallback when `git status` is unavailable: report every event path as
/// modified.
fn changed_files_from_events(events: &BTreeSet<String>) -> Vec<git::ChangedFile> {
    events
        .iter()
        .filter_map(|event| {
            let event = event.trim_matches('/');
            (!event.is_empty()).then(|| git::ChangedFile {
                path: event.to_string(),
                action: git::ChangeAction::Modified,
            })
        })
        .collect()
}

const IGNORED_DIRS: [&str; 4] = ["node_modules", ".git", ".hg", ".svn"];

/// Always-ignored paths, independent of gitignore: VCS internals and the comment
/// store's atomic-write temp files (which live in a tracked `.diffs/` dir, so
/// gitignore would not catch them, and watching them would cause reload loops).
/// Matches on whole path components, so it is separator-agnostic on Windows.
fn is_structurally_ignored(path: &FsPath) -> bool {
    path.components().any(|component| {
        let std::path::Component::Normal(name) = component else {
            return false;
        };
        let Some(name) = name.to_str() else {
            return false;
        };
        IGNORED_DIRS.contains(&name) || (name.starts_with(".comments-") && name.ends_with(".json"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirty_enabled_accepts_only_truthy_aliases() {
        for truthy in ["1", "true", "yes", "on", "YES", "On", " true ", "\tTRUE\n"] {
            assert!(dirty_enabled(Some(truthy)), "{truthy:?} should be truthy");
        }
        for falsy in [
            Some("0"),
            Some("false"),
            Some("no"),
            Some(""),
            Some("enabled"),
            None,
        ] {
            assert!(!dirty_enabled(falsy), "{falsy:?} should be falsy");
        }
    }

    // Drives the real hyper accept loop over a TCP socket to prove the
    // header-read timeout is wired up. A missing TokioTimer compiles fine but
    // panics at runtime, so only a live test catches it.
    #[tokio::test]
    async fn serve_router_enforces_header_read_timeout() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::{TcpListener, TcpStream};

        let router = axum::Router::new().route("/", axum::routing::get(|| async { "ok" }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = serve_router(listener, router).await;
        });

        // A well-formed request is served normally.
        let mut ok = TcpStream::connect(addr).await.unwrap();
        ok.write_all(b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut buf = Vec::new();
        ok.read_to_end(&mut buf).await.unwrap();
        let resp = String::from_utf8_lossy(&buf);
        assert!(
            resp.starts_with("HTTP/1.1 200"),
            "unexpected response: {resp}"
        );

        // A client that opens a connection but never finishes its request
        // headers is dropped by the header-read timeout, not left open forever.
        let start = std::time::Instant::now();
        let mut slow = TcpStream::connect(addr).await.unwrap();
        slow.write_all(b"GET / HTTP/1.1\r\n").await.unwrap(); // never terminated
        let mut sink = Vec::new();
        let read = tokio::time::timeout(
            READ_HEADER_TIMEOUT + Duration::from_secs(3),
            slow.read_to_end(&mut sink),
        )
        .await
        .expect("server did not close the idle connection within the timeout window")
        .unwrap();
        assert_eq!(
            read, 0,
            "expected EOF from server-side close, got {read} bytes"
        );
        // Confirm it was the timeout firing, not an instant reject.
        assert!(
            start.elapsed() >= Duration::from_secs(3),
            "connection closed too early ({:?}); timeout may not be enforced",
            start.elapsed()
        );
    }

    #[test]
    fn is_safe_ref_arg_accepts_branch_like_refs() {
        for ok in ["main", "origin/main", "feature/x", "release-1.2"] {
            assert!(is_safe_ref_arg(ok), "{ok} should be safe");
        }
        for bad in [
            "", "-flag", "a..b", "HEAD~1", "x^", "@", "a{b", "a}b", "a\\b", "a b", "a:b", "a?b",
            "a*b", "a[b",
        ] {
            assert!(!is_safe_ref_arg(bad), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn pr_path_validators() {
        assert!(pull_number("123"));
        assert!(!pull_number("0"));
        assert!(!pull_number("012"));
        assert!(!pull_number(""));
        assert!(!pull_number("12a"));

        assert!(safe_path_part("org.repo-1_x"));
        assert!(!safe_path_part(""));
        assert!(!safe_path_part("-x"));
        assert!(!safe_path_part("a/b"));
        assert!(!safe_path_part("a..b"));
        assert!(!safe_path_part("a b"));
    }

    #[test]
    fn comment_scope_classification() {
        let local = CommentTargetQuery {
            org: None,
            repo: None,
            number: None,
        };
        assert!(matches!(comment_scope(&local), CommentScope::Local));

        let pull = CommentTargetQuery {
            org: Some("org".into()),
            repo: Some("repo".into()),
            number: Some("123".into()),
        };
        match comment_scope(&pull) {
            CommentScope::Pull(t) => assert_eq!(
                (t.org, t.repo, t.number),
                ("org".into(), "repo".into(), "123".into())
            ),
            _ => panic!("expected pull scope"),
        }

        let invalid = CommentTargetQuery {
            org: Some("../bad".into()),
            repo: Some("repo".into()),
            number: Some("123".into()),
        };
        assert!(matches!(comment_scope(&invalid), CommentScope::Invalid));
    }

    #[test]
    fn git_state_file_detection() {
        let git_dir = FsPath::new("/repo/.git");
        assert!(is_git_state_file(git_dir, FsPath::new("/repo/.git/HEAD")));
        assert!(is_git_state_file(git_dir, FsPath::new("/repo/.git/index")));
        assert!(is_git_state_file(
            git_dir,
            FsPath::new("/repo/.git/refs/heads/main")
        ));
        assert!(is_git_state_file(
            git_dir,
            FsPath::new("/repo/.git/logs/HEAD")
        ));
        assert!(is_git_state_file(git_dir, FsPath::new("/repo/.git")));
        assert!(!is_git_state_file(
            git_dir,
            FsPath::new("/repo/.git/objects/ab/cd")
        ));
        assert!(!is_git_state_file(
            git_dir,
            FsPath::new("/repo/src/main.rs")
        ));
    }

    #[test]
    fn structural_ignore_matches_components() {
        assert!(is_structurally_ignored(FsPath::new(
            "/repo/node_modules/x/y.js"
        )));
        assert!(is_structurally_ignored(FsPath::new("/repo/.git/HEAD")));
        assert!(is_structurally_ignored(FsPath::new(
            "/repo/.diffs/.comments-ab12.json"
        )));
        assert!(!is_structurally_ignored(FsPath::new(
            "/repo/src/.gitignore"
        )));
        assert!(!is_structurally_ignored(FsPath::new("/repo/my.git/x")));
    }

    #[test]
    fn changed_files_for_events_intersects_status() {
        let mut status = BTreeMap::new();
        status.insert("src/a.rs".to_string(), git::ChangeAction::Modified);
        status.insert("src/b.rs".to_string(), git::ChangeAction::Added);
        status.insert("docs/c.md".to_string(), git::ChangeAction::Deleted);

        // Direct hit + directory-prefix expansion; "missing" is dropped.
        let events: BTreeSet<String> = ["src/a.rs", "docs", "missing"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let changed = changed_files_for_events(&events, &status);
        let got: Vec<(&str, git::ChangeAction)> = changed
            .iter()
            .map(|c| (c.path.as_str(), c.action))
            .collect();
        assert_eq!(
            got,
            vec![
                ("docs/c.md", git::ChangeAction::Deleted),
                ("src/a.rs", git::ChangeAction::Modified),
            ]
        );
    }

    #[test]
    fn changed_files_from_events_marks_modified() {
        let events: BTreeSet<String> = ["b.rs", "a.rs"].iter().map(|s| s.to_string()).collect();
        let changed = changed_files_from_events(&events);
        assert_eq!(changed.len(), 2);
        assert_eq!(changed[0].path, "a.rs"); // sorted
        assert!(
            changed
                .iter()
                .all(|c| c.action == git::ChangeAction::Modified)
        );
    }
}
