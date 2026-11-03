use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A synthetic procfs directory for one test.
struct LimitsDir {
    path: PathBuf,
}

impl LimitsDir {
    fn new(watches: &str, instances: &str) -> Self {
        let unique = format!(
            "ops-linux-limits-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
            watches.len() + instances.len()
        );
        let path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("max_user_watches"), watches).unwrap();
        std::fs::write(path.join("max_user_instances"), instances).unwrap();
        Self { path }
    }
}

impl Drop for LimitsDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[test]
fn reads_the_limits_with_a_trailing_newline() {
    let dir = LimitsDir::new("65536\n", "128\n");
    let limits = WatchLimits::read_from(&dir.path).unwrap();
    assert_eq!(limits.max_user_watches, 65_536);
    assert_eq!(limits.max_user_instances, 128);
    assert!(limits.can_watch());
}

#[test]
fn tolerates_surrounding_whitespace_and_large_values() {
    assert_eq!(parse_limit(" 42 \n"), Some(42));
    assert_eq!(parse_limit(&u64::MAX.to_string()), Some(u64::MAX));
}

#[test]
fn rejects_empty_and_non_decimal_bodies() {
    assert_eq!(parse_limit(""), None);
    assert_eq!(parse_limit("\n"), None);
    assert_eq!(parse_limit("12\n34"), None);
    assert_eq!(parse_limit("abc"), None);
    assert_eq!(parse_limit("-1"), None);
}

#[test]
fn a_missing_limit_file_is_an_io_error() {
    let dir = LimitsDir::new("1\n", "1\n");
    std::fs::remove_file(dir.path.join("max_user_instances")).unwrap();
    let error = WatchLimits::read_from(&dir.path).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::NotFound);
}

#[test]
fn a_malformed_limit_file_is_invalid_data() {
    let dir = LimitsDir::new("not-a-number\n", "1\n");
    let error = WatchLimits::read_from(&dir.path).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("max_user_watches"));
}

#[test]
fn zero_budgets_cannot_watch() {
    let no_watches = LimitsDir::new("0\n", "128\n");
    assert!(
        !WatchLimits::read_from(&no_watches.path)
            .unwrap()
            .can_watch()
    );
    let no_instances = LimitsDir::new("65536\n", "0\n");
    assert!(
        !WatchLimits::read_from(&no_instances.path)
            .unwrap()
            .can_watch()
    );
}

#[test]
fn enospc_means_the_watch_budget_is_exhausted_and_polling_will_take_over() {
    let enospc = io::Error::from(io::ErrorKind::StorageFull);
    assert_eq!(
        DegradeReason::classify(&enospc),
        DegradeReason::WatchLimitExhausted
    );
    let raw = io::Error::from_raw_os_error(ENOSPC);
    assert_eq!(
        DegradeReason::classify(&raw),
        DegradeReason::WatchLimitExhausted
    );
    assert!(DegradeReason::WatchLimitExhausted.needs_polling());
    assert_eq!(
        DegradeReason::WatchLimitExhausted.code(),
        "INDEX_WATCH_LIMIT_EXHAUSTED"
    );
}

#[test]
fn fd_exhaustion_also_falls_back_to_polling() {
    for code in [EMFILE, ENFILE] {
        let error = io::Error::from_raw_os_error(code);
        assert_eq!(DegradeReason::classify(&error), DegradeReason::FdExhausted);
        assert!(DegradeReason::FdExhausted.needs_polling());
    }
    assert_eq!(
        DegradeReason::FdExhausted.code(),
        "INDEX_WATCH_FDS_EXHAUSTED"
    );
}

#[test]
fn other_io_failures_are_not_silently_downgraded_to_polling() {
    let denied = io::Error::from(io::ErrorKind::PermissionDenied);
    let reason = DegradeReason::classify(&denied);
    assert_eq!(reason, DegradeReason::Io(io::ErrorKind::PermissionDenied));
    assert!(!reason.needs_polling());
    assert_eq!(reason.code(), "INDEX_WATCH_IO");
}
