//! Disposable signal-controller failure fixture, never a production entry point.
fn main() {
    assert_eq!(
        std::env::args().nth(1).as_deref(),
        Some("--ops-signal-console")
    );
    eprintln!("fixture-controller-pid:{}", std::process::id());
    if std::env::current_exe().unwrap().file_stem().unwrap() == "signal-stall" {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }
    std::process::abort();
}
