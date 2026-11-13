//! Repository-only deterministic cancellation fixture. The server is the
//! actual production module; only the one-shot leaf has controlled blocking.
#[path = "../src/resident.rs"]
mod resident;
#[path = "../src/shell/mod.rs"]
mod shell;
use std::{
    io::{Read, Write},
    time::Duration,
};

fn main() {
    if std::env::args().any(|arg| arg == "--serve") {
        if let Err(error) = resident::serve() {
            eprintln!("Fixture kernel stopped: {error}");
            std::process::exit(1);
        }
        return;
    }
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input).unwrap();
    let request: serde_json::Value = serde_json::from_slice(&input).unwrap();
    let args = &request["request"]["args"];
    if let Some(ready) = args["ready"].as_str() {
        std::fs::write(ready, std::process::id().to_string()).unwrap();
        // A fixed long wait makes early completion impossible. No descendants,
        // test environment hooks, or fixture behavior enter the shipped binary.
        std::thread::sleep(Duration::from_secs(600));
    }
    let response = serde_json::json!({"status":"completed","data":{
        "receipt":args["receipt"], "pid":std::process::id()
    }});
    std::io::stdout()
        .write_all(response.to_string().as_bytes())
        .unwrap();
}
