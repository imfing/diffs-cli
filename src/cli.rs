use crate::{comments, config, gh, git, server};
use anyhow::{Context, bail};
use clap::{Args, Parser, Subcommand};
use std::{
    io::{self, IsTerminal, Read, Write},
    net::{SocketAddr, TcpListener},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 3433;
const RELOAD_DEBOUNCE: Duration = Duration::from_millis(500);

/// Error that signals a non-zero exit without printing anything (help/diagnostics
/// were already written).
#[derive(Debug)]
pub struct QuietExit;

impl std::fmt::Display for QuietExit {
    fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        Ok(())
    }
}

impl std::error::Error for QuietExit {}

#[derive(Parser)]
#[command(name = "diffs")]
#[command(about = "Review local diffs and GitHub pull requests in a browser")]
struct Cli {
    #[arg(long, default_value = ".")]
    dir: PathBuf,
    #[command(flatten)]
    serve: ServeFlags,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Clone, Args)]
struct ServeFlags {
    #[arg(long, default_value = DEFAULT_HOST)]
    host: String,
    #[arg(long, default_value_t = DEFAULT_PORT)]
    port: u16,
    #[arg(long)]
    no_open: bool,
}

#[derive(Subcommand)]
enum Command {
    #[command(about = "Review a GitHub pull request")]
    Pr {
        target: Option<String>,
        #[arg(long)]
        gh_host: Option<String>,
        #[command(flatten)]
        serve: ServeFlags,
    },
    #[command(about = "Review commits on the current branch against a base")]
    Branch {
        base: Option<String>,
        #[arg(long)]
        include_dirty: bool,
        #[command(flatten)]
        serve: ServeFlags,
    },
    #[command(about = "Manage local review comments")]
    Comments(CommentsCommand),
    #[command(about = "Print version information")]
    Version,
}

#[derive(Args)]
struct CommentsCommand {
    #[arg(long)]
    json: bool,
    #[command(subcommand)]
    command: CommentSubcommand,
}

#[derive(Subcommand)]
enum CommentSubcommand {
    #[command(about = "List local comment threads for the current branch")]
    List,
    #[command(about = "Create a local comment thread")]
    Add {
        #[arg(long = "file")]
        path: String,
        #[arg(long)]
        line: u32,
        #[arg(long, default_value = comments::DEFAULT_SIDE)]
        side: String,
        #[arg(long)]
        end_line: Option<u32>,
        #[arg(long, default_value = "")]
        end_side: String,
        #[arg(long)]
        body: String,
        #[arg(long, default_value = "")]
        author: String,
    },
    #[command(about = "Reply to a local comment thread")]
    Reply {
        thread_id: String,
        #[arg(long)]
        body: String,
        #[arg(long, default_value = "")]
        author: String,
    },
    #[command(about = "Resolve a local comment thread")]
    Resolve { thread_id: String },
    #[command(about = "Reopen a resolved local comment thread")]
    Reopen { thread_id: String },
}

pub async fn run(started: Instant) -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        None => {
            run_server_target(&cli.dir, &cli.serve, gh_host(None), "/local", true, started).await
        }
        Some(Command::Pr {
            target,
            gh_host: host,
            serve,
        }) => {
            let args = target.into_iter().collect::<Vec<_>>();
            let target = gh::pr_target_from_args(&args, &cli.dir).await?;
            let host = gh_host(host).or_else(|| (!target.host.is_empty()).then_some(target.host));
            run_server_target(&cli.dir, &serve, host, &target.path, false, started).await
        }
        Some(Command::Branch {
            base,
            include_dirty,
            serve,
        }) => {
            // Fail with the formatted git help before inferring a base, so a
            // non-repo gives the same UX as the local command (not a confusing
            // "could not infer base ref").
            resolve_repo_root_or_help(&cli.dir)?;
            let base = resolve_branch_base(base, &cli.dir).await?;
            let target = branch_target(&base, include_dirty);
            run_server_target(&cli.dir, &serve, gh_host(None), &target, true, started).await
        }
        Some(Command::Comments(command)) => run_comments(&cli.dir, command),
        Some(Command::Version) => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
    }
}

async fn run_server_target(
    dir: &Path,
    flags: &ServeFlags,
    github_host: Option<String>,
    target_path: &str,
    watch: bool,
    started: Instant,
) -> anyhow::Result<()> {
    let stdout_color = colors_enabled(io::stdout().is_terminal());
    let cwd = if watch {
        resolve_repo_root_or_help(dir)?
    } else {
        dir.to_path_buf()
    };
    // Canonicalize for a clean, symlink-resolved display (no libgit2 trailing
    // slash) that also matches the cwd the server resolves internally.
    let cwd = std::fs::canonicalize(&cwd)?;
    let app_cfg = config::load_default().context("load config")?;
    let on_change: Option<server::OnChange> =
        watch.then(|| new_reload_logger(stdout_color) as server::OnChange);
    let running = server::new(server::ServerConfig {
        cwd: cwd.clone(),
        github_host: github_host.unwrap_or_else(|| gh::DEFAULT_GITHUB_HOST.to_string()),
        ui: app_cfg.ui,
        watch,
        on_change,
    })?;
    let (listener, requested, actual) = bind_with_fallback(&flags.host, flags.port)?;
    let url = browser_url(actual, target_path);
    if requested.port() != 0 && requested != actual {
        print_port_fallback(&requested.to_string(), &actual.to_string(), stdout_color);
    }
    print_startup(
        &StartupInfo {
            url: &url,
            target: &target_label(target_path, &cwd),
            cwd: &cwd.display().to_string(),
            watching: watch,
            elapsed: started.elapsed(),
        },
        stdout_color,
    );
    if !flags.no_open
        && let Err(err) = open::that(&url)
    {
        eprintln!("warning: could not open browser: {err}");
    }
    let listener = tokio::net::TcpListener::from_std(listener)?;
    server::serve_router(listener, running.router).await
}

// --- Terminal output ---

struct Colors {
    reset: &'static str,
    dim: &'static str,
    green: &'static str,
    cyan: &'static str,
    yellow: &'static str,
    red: &'static str,
    magenta: &'static str,
}

fn colors_enabled(is_terminal: bool) -> bool {
    if std::env::var_os("NO_COLOR").is_some() {
        return false;
    }
    if std::env::var("TERM").is_ok_and(|term| term == "dumb") {
        return false;
    }
    is_terminal
}

fn palette(enabled: bool) -> Colors {
    if enabled {
        Colors {
            reset: "\x1b[0m",
            dim: "\x1b[2m",
            green: "\x1b[32m",
            cyan: "\x1b[36m",
            yellow: "\x1b[33m",
            red: "\x1b[31m",
            magenta: "\x1b[35m",
        }
    } else {
        Colors {
            reset: "",
            dim: "",
            green: "",
            cyan: "",
            yellow: "",
            red: "",
            magenta: "",
        }
    }
}

fn colorize(text: &str, color: &str, reset: &str) -> String {
    if color.is_empty() {
        text.to_string()
    } else {
        format!("{color}{text}{reset}")
    }
}

fn log_line(c: &Colors, label: &str, message: &str, color: &str) -> String {
    let color = if color.is_empty() { c.green } else { color };
    format!("  {color}{label:<8}{} {message}", c.reset)
}

struct StartupInfo<'a> {
    url: &'a str,
    target: &'a str,
    cwd: &'a str,
    watching: bool,
    elapsed: Duration,
}

fn print_startup(info: &StartupInfo<'_>, color: bool) {
    let c = palette(color);
    println!();
    println!(
        "{}",
        log_line(
            &c,
            "diffs",
            &format!("ready in {}", format_ready_duration(info.elapsed)),
            "",
        )
    );
    println!(
        "{}",
        log_line(&c, "serve", &colorize(info.url, c.cyan, c.reset), "")
    );
    println!("{}", log_line(&c, "target", info.target, ""));
    if info.watching {
        println!("{}", log_line(&c, "watch", info.cwd, ""));
    }
    println!(
        "{}",
        log_line(&c, "stop", &colorize("Ctrl+C", c.dim, c.reset), "")
    );
    println!();
}

fn print_port_fallback(requested: &str, actual: &str, color: bool) {
    let c = palette(color);
    println!();
    println!(
        "{}",
        log_line(
            &c,
            "warn",
            &format!("{requested} in use; using {actual}"),
            c.yellow
        )
    );
}

fn print_local_git_help(dir: &str, color: bool) {
    let c = palette(color);
    eprintln!();
    eprintln!(
        "{}",
        log_line(&c, "error", &format!("not a git repository: {dir}"), "")
    );
    eprintln!("{}", log_line(&c, "hint", "run from a git repository", ""));
    eprintln!(
        "{}",
        log_line(&c, "hint", "or pass --dir /path/to/repo", "")
    );
    eprintln!(
        "{}",
        log_line(&c, "hint", "or use diffs pr /org/repo/pull/123", "")
    );
    eprintln!();
}

fn format_ready_duration(elapsed: Duration) -> String {
    let ms = (elapsed.as_secs_f64() * 1000.0).round() as i64;
    format!("{} ms", ms.max(1))
}

fn new_reload_logger(color: bool) -> server::OnChange {
    let last: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
    Arc::new(move |files: Vec<git::ChangedFile>| {
        let now = Instant::now();
        {
            let mut guard = last.lock().expect("reload logger lock poisoned");
            if let Some(prev) = *guard
                && now.duration_since(prev) < RELOAD_DEBOUNCE
            {
                return;
            }
            *guard = Some(now);
        }
        print_reload(&files, color);
    })
}

fn print_reload(files: &[git::ChangedFile], color: bool) {
    let c = palette(color);
    let (label, message) = reload_line(files, &c, color);
    let label_color = reload_label_color(files.first().map(|f| f.action), &c);
    println!("{}", log_line(&c, &label, &message, label_color));
}

fn reload_line(files: &[git::ChangedFile], c: &Colors, color: bool) -> (String, String) {
    let Some(first) = files.first() else {
        return ("change".to_string(), "local changes".to_string());
    };
    let label = first.action.as_str().to_string();
    let path = if color {
        colorize(&first.path, c.cyan, c.reset)
    } else {
        first.path.clone()
    };
    if files.len() == 1 {
        (label, path)
    } else {
        (label, format!("{path} (+{} more)", files.len() - 1))
    }
}

fn reload_label_color(action: Option<git::ChangeAction>, c: &Colors) -> &'static str {
    match action {
        Some(git::ChangeAction::Added) => c.green,
        Some(git::ChangeAction::Modified) => c.yellow,
        Some(git::ChangeAction::Deleted) => c.red,
        Some(git::ChangeAction::Renamed) => c.magenta,
        None => c.green,
    }
}

/// Builds the human label for the served target.
fn target_label(target_path: &str, cwd: &std::path::Path) -> String {
    if target_path == "/local" {
        let branch = git::branch(cwd);
        return if branch.is_empty() {
            "local repository".to_string()
        } else {
            branch
        };
    }
    if target_path.starts_with("/branch") {
        let base = branch_base_from_target(target_path);
        let head = git::branch(cwd);
        let head = if head.is_empty() { "HEAD" } else { &head };
        return if base.is_empty() {
            format!("{head} branch diff")
        } else {
            format!("{head} -> {base}")
        };
    }
    let parts: Vec<&str> = target_path.trim_matches('/').split('/').collect();
    if parts.len() == 4 && parts[2] == "pull" {
        return format!("GitHub PR {}/{}#{}", parts[0], parts[1], parts[3]);
    }
    target_path.to_string()
}

fn branch_base_from_target(target_path: &str) -> String {
    let Some((_, query)) = target_path.split_once('?') else {
        return String::new();
    };
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == "base")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default()
}

fn bind_with_fallback(
    host: &str,
    port: u16,
) -> anyhow::Result<(TcpListener, SocketAddr, SocketAddr)> {
    let host = if host.trim().is_empty() || host.trim() == "localhost" {
        DEFAULT_HOST
    } else {
        host.trim()
    };
    let requested: SocketAddr = format!("{host}:{port}").parse()?;
    match TcpListener::bind(requested) {
        Ok(listener) => {
            listener.set_nonblocking(true)?;
            let actual = listener.local_addr()?;
            Ok((listener, requested, actual))
        }
        Err(err) if err.kind() == io::ErrorKind::AddrInUse && port != 0 => {
            let fallback: SocketAddr = format!("{host}:0").parse()?;
            let listener = TcpListener::bind(fallback)?;
            listener.set_nonblocking(true)?;
            let actual = listener.local_addr()?;
            Ok((listener, requested, actual))
        }
        Err(err) => Err(err.into()),
    }
}

fn browser_url(addr: SocketAddr, target_path: &str) -> String {
    let host = if addr.ip().is_unspecified() {
        DEFAULT_HOST.to_string()
    } else {
        addr.ip().to_string()
    };
    format!("http://{host}:{}{}", addr.port(), target_path)
}

async fn resolve_branch_base(base: Option<String>, dir: &PathBuf) -> anyhow::Result<String> {
    if let Some(base) = base
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return Ok(base);
    }
    for args in [
        ["pr", "view", "--json", "baseRefName", "-q", ".baseRefName"],
        [
            "repo",
            "view",
            "--json",
            "defaultBranchRef",
            "-q",
            ".defaultBranchRef.name",
        ],
    ] {
        if let Ok(candidate) = gh::run(dir, &args).await
            && let Some(resolved) = git::resolve_local_ref(dir, &candidate)
        {
            return Ok(resolved);
        }
    }
    for candidate in ["main", "master"] {
        if let Some(resolved) = git::resolve_local_ref(dir, candidate) {
            return Ok(resolved);
        }
    }
    bail!("could not infer base ref; pass one explicitly, e.g. `diffs branch main`")
}

fn branch_target(base: &str, include_dirty: bool) -> String {
    let mut params = url::form_urlencoded::Serializer::new(String::new());
    params.append_pair("base", base);
    if include_dirty {
        params.append_pair("dirty", "1");
    }
    format!("/branch?{}", params.finish())
}

/// Resolves the repository working-tree root, or prints the formatted git help
/// to stderr and returns `QuietExit` so the caller exits 1 without a duplicate
/// error line. Shared by the local and branch commands.
fn resolve_repo_root_or_help(dir: &Path) -> anyhow::Result<PathBuf> {
    match git::root(dir) {
        Ok(root) => Ok(root),
        Err(_) => {
            print_local_git_help(
                &dir.display().to_string(),
                colors_enabled(io::stderr().is_terminal()),
            );
            Err(QuietExit.into())
        }
    }
}

fn gh_host(flag: Option<String>) -> Option<String> {
    flag.or_else(|| std::env::var("GH_HOST").ok())
        .map(|host| host.trim().to_string())
        .filter(|host| !host.is_empty())
}

fn run_comments(dir: &PathBuf, command: CommentsCommand) -> anyhow::Result<()> {
    let store = comments::Store::new(dir)?;
    match command.command {
        CommentSubcommand::List => {
            let threads = store.list()?;
            if command.json {
                print_json(&serde_json::json!({ "threads": threads }))?;
            } else {
                print_threads(&threads);
            }
        }
        CommentSubcommand::Add {
            path,
            line,
            side,
            end_line,
            end_side,
            body,
            author,
        } => {
            let thread = store.add_thread(comments::AddThreadInput {
                path,
                side,
                line,
                end_line: end_line.unwrap_or_default(),
                end_side,
                body: body_from_flag(body)?,
                author,
            })?;
            print_thread_result(&thread, command.json)?;
        }
        CommentSubcommand::Reply {
            thread_id,
            body,
            author,
        } => {
            let thread = store.add_reply(
                &thread_id,
                comments::AddReplyInput {
                    body: body_from_flag(body)?,
                    author,
                },
            )?;
            print_thread_result(&thread, command.json)?;
        }
        CommentSubcommand::Resolve { thread_id } => {
            let thread = store.resolve(&thread_id)?;
            print_thread_result(&thread, command.json)?;
        }
        CommentSubcommand::Reopen { thread_id } => {
            let thread = store.reopen(&thread_id)?;
            print_thread_result(&thread, command.json)?;
        }
    }
    Ok(())
}

fn body_from_flag(body: String) -> anyhow::Result<String> {
    if body != "-" {
        return Ok(body);
    }
    let mut data = String::new();
    io::stdin().read_to_string(&mut data)?;
    Ok(data)
}

fn print_json(value: &serde_json::Value) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn print_thread_result(thread: &comments::Thread, as_json: bool) -> anyhow::Result<()> {
    if as_json {
        println!("{}", serde_json::to_string_pretty(thread)?);
    } else {
        println!(
            "{}\t{}\t{}\t{}",
            thread.id,
            thread.status,
            thread_location(thread),
            latest_comment_body(thread)
        );
    }
    Ok(())
}

fn print_threads(threads: &[comments::Thread]) {
    if threads.is_empty() {
        println!("No local comment threads.");
        return;
    }
    println!("ID\tSTATUS\tLOCATION\tCOMMENTS\tLATEST");
    for thread in threads {
        println!(
            "{}\t{}\t{}\t{}\t{}",
            thread.id,
            thread.status,
            thread_location(thread),
            thread.comments.len(),
            latest_comment_body(thread)
        );
    }
    let _ = io::stdout().flush();
}

fn thread_location(thread: &comments::Thread) -> String {
    let end_line = if thread.end_line == 0 {
        thread.line
    } else {
        thread.end_line
    };
    if end_line == thread.line {
        format!("{}:{}", thread.path, thread.line)
    } else {
        format!("{}:{}-{end_line}", thread.path, thread.line)
    }
}

fn latest_comment_body(thread: &comments::Thread) -> String {
    const LIMIT: usize = 72;
    let Some(comment) = thread.comments.last() else {
        return String::new();
    };
    let body = comment.body.replace('\n', " ");
    let mut chars = body.chars();
    let preview: String = chars.by_ref().take(LIMIT - 3).collect();
    if chars.next().is_some() {
        format!("{preview}...")
    } else {
        body
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener as StdTcpListener;

    fn run_git(dir: &std::path::Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }

    #[test]
    fn branch_target_encodes_base_and_dirty() {
        assert_eq!(
            branch_target("origin/main", false),
            "/branch?base=origin%2Fmain"
        );
        assert_eq!(
            branch_target("origin/main", true),
            "/branch?base=origin%2Fmain&dirty=1"
        );
    }

    #[test]
    fn branch_base_from_target_decodes_base() {
        assert_eq!(
            branch_base_from_target("/branch?base=origin%2Fmain"),
            "origin/main"
        );
        assert_eq!(branch_base_from_target("/branch?base=main&dirty=1"), "main");
        assert_eq!(branch_base_from_target("/local"), "");
    }

    #[test]
    fn browser_url_uses_loopback_for_wildcard() {
        let addr: SocketAddr = "0.0.0.0:3433".parse().unwrap();
        assert_eq!(browser_url(addr, "/local"), "http://127.0.0.1:3433/local");
    }

    #[test]
    fn target_label_variants() {
        let dir = tempfile::tempdir().unwrap();
        run_git(dir.path(), &["init"]);
        run_git(dir.path(), &["checkout", "-b", "feature/startup"]);

        assert_eq!(target_label("/local", dir.path()), "feature/startup");
        assert_eq!(
            target_label("/branch?base=origin%2Fmain", dir.path()),
            "feature/startup -> origin/main"
        );
        assert_eq!(
            target_label("/org/repo/pull/123", dir.path()),
            "GitHub PR org/repo#123"
        );
        assert_eq!(
            target_label("/local", &dir.path().join("missing")),
            "local repository"
        );
    }

    fn changed(action: git::ChangeAction, path: &str) -> git::ChangedFile {
        git::ChangedFile {
            path: path.to_string(),
            action,
        }
    }

    #[test]
    fn reload_line_summarizes_multiple_paths() {
        let files = [
            changed(git::ChangeAction::Added, "a.go"),
            changed(git::ChangeAction::Modified, "b.go"),
            changed(git::ChangeAction::Deleted, "c.go"),
        ];
        let (label, message) = reload_line(&files, &palette(false), false);
        assert_eq!(label, "added");
        assert_eq!(message, "a.go (+2 more)");
    }

    #[test]
    fn reload_line_colors_single_path() {
        let colors = Colors {
            reset: "Z",
            cyan: "C",
            dim: "",
            green: "",
            yellow: "",
            red: "",
            magenta: "",
        };
        let files = [changed(git::ChangeAction::Modified, "a.go")];
        let (label, message) = reload_line(&files, &colors, true);
        assert_eq!(label, "modified");
        assert_eq!(message, "Ca.goZ");
    }

    #[test]
    fn reload_line_falls_back_to_change_label() {
        let (label, message) = reload_line(&[], &palette(false), false);
        assert_eq!(label, "change");
        assert_eq!(message, "local changes");
    }

    #[test]
    fn reload_label_color_by_action() {
        let c = palette(true);
        assert_eq!(
            reload_label_color(Some(git::ChangeAction::Added), &c),
            c.green
        );
        assert_eq!(
            reload_label_color(Some(git::ChangeAction::Modified), &c),
            c.yellow
        );
        assert_eq!(
            reload_label_color(Some(git::ChangeAction::Deleted), &c),
            c.red
        );
        assert_eq!(
            reload_label_color(Some(git::ChangeAction::Renamed), &c),
            c.magenta
        );
        assert_eq!(reload_label_color(None, &c), c.green);
    }

    #[test]
    fn format_ready_duration_has_floor_of_one_ms() {
        assert_eq!(format_ready_duration(Duration::from_millis(0)), "1 ms");
        assert_eq!(format_ready_duration(Duration::from_micros(200)), "1 ms");
        assert_eq!(format_ready_duration(Duration::from_millis(7)), "7 ms");
    }

    #[test]
    fn latest_comment_body_truncates_utf8_safely() {
        let body = "评".repeat(80) + " done";
        let thread = comments::Thread {
            id: "t".into(),
            provider: "local".into(),
            branch: "main".into(),
            path: "a.go".into(),
            side: "additions".into(),
            line: 1,
            end_side: String::new(),
            end_line: 0,
            status: "open".into(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            comments: vec![comments::Comment {
                id: "c".into(),
                author: "a".into(),
                body,
                created_at: chrono::Utc::now(),
            }],
            reply_to_id: None,
            url: String::new(),
        };
        let got = latest_comment_body(&thread);
        assert!(got.is_char_boundary(got.len()));
        assert_eq!(got.matches('评').count(), 69);
        assert!(got.ends_with("..."));
    }

    #[test]
    fn resolve_repo_root_or_help_quiet_exits_outside_repo() {
        let dir = tempfile::tempdir().unwrap();
        let err = resolve_repo_root_or_help(dir.path()).unwrap_err();
        assert!(
            err.downcast_ref::<QuietExit>().is_some(),
            "expected QuietExit, got: {err}"
        );
    }

    #[test]
    fn resolve_repo_root_or_help_returns_root_in_repo() {
        let dir = tempfile::tempdir().unwrap();
        run_git(dir.path(), &["init"]);
        let root = resolve_repo_root_or_help(dir.path()).unwrap();
        assert_eq!(
            root.canonicalize().unwrap(),
            dir.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn bind_with_fallback_uses_random_port_when_busy() {
        let busy = StdTcpListener::bind("127.0.0.1:0").unwrap();
        let port = busy.local_addr().unwrap().port();

        let (listener, requested, actual) = bind_with_fallback("127.0.0.1", port).unwrap();
        assert_eq!(requested.port(), port);
        assert_ne!(actual.port(), 0);
        assert_ne!(actual.port(), port);
        drop(listener);
    }
}
