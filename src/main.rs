#[tokio::main]
async fn main() {
    let started = std::time::Instant::now();
    if let Err(err) = diffs::cli::run(started).await {
        if err.downcast_ref::<diffs::cli::QuietExit>().is_none() {
            eprintln!("{err}");
        }
        std::process::exit(1);
    }
}
