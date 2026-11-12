use super::*;
use ops_index::source::{EnumBudget, FsDataSource};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

static NEXT: AtomicUsize = AtomicUsize::new(0);

fn temp_root(label: &str) -> PathBuf {
    let unique = format!(
        "ops-linux-source-{}-{}-{label}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let root = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&root).unwrap();
    root
}

struct Cleanup(PathBuf);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn budget() -> EnumBudget {
    EnumBudget::with_timeout(100, 4, Duration::from_secs(30))
}

#[test]
fn the_production_source_is_unwatched_and_unsupported() {
    let source = LinuxSource::new();
    assert_eq!(source.phase(), Phase::Unwatched);
    assert_eq!(
        source.state(Path::new("/")),
        SourceState::Unsupported,
        "cold enumeration alone cannot prove freshness"
    );
    assert_eq!(LinuxSource::default().phase(), Phase::Unwatched);
}

#[test]
fn catching_up_is_reported_as_offline() {
    let source = LinuxSource::with_phase(Phase::CatchingUp);
    assert_eq!(source.state(Path::new("/")), SourceState::Unavailable);
}

#[test]
fn live_is_reported_as_ready_with_its_snapshot_and_stamp() {
    let phase = Phase::Live {
        snapshot: SnapshotId::new(9),
        consistent_at_ms: 1_780,
    };
    let source = LinuxSource::with_phase(phase);
    assert_eq!(source.phase(), phase);
    assert_eq!(
        source.state(Path::new("/")),
        SourceState::Ready {
            snapshot: SnapshotId::new(9),
            consistent_at_ms: 1_780,
        }
    );
}

#[test]
fn the_state_mapping_is_pinned_through_a_trait_object() {
    let sources: [(&dyn FsDataSource, bool); 3] = [
        (&LinuxSource::new(), false),
        (&LinuxSource::with_phase(Phase::CatchingUp), false),
        (
            &LinuxSource::with_phase(Phase::Live {
                snapshot: SnapshotId::new(1),
                consistent_at_ms: 0,
            }),
            true,
        ),
    ];
    for (source, ready) in sources {
        assert_eq!(source.state(Path::new("/")).is_ready(), ready);
    }
}

#[test]
fn enumerate_delegates_to_the_cold_walk() {
    let root = temp_root("enumerate");
    let _cleanup = Cleanup(root.clone());
    std::fs::write(root.join("a.txt"), b"abc").unwrap();

    let set = LinuxSource::new().enumerate(&root, budget()).unwrap();
    assert_eq!(set.entries.len(), 1);
    assert_eq!(set.entries[0].rel, Path::new("a.txt"));
    assert!(!set.truncated);
}

#[test]
fn changes_report_unsupported_without_a_watcher_and_not_ready_while_catching_up() {
    let root = Path::new("/");
    let live = Phase::Live {
        snapshot: SnapshotId::new(2),
        consistent_at_ms: 5,
    };
    assert_eq!(
        LinuxSource::new().changes(root, SnapshotId::new(0)),
        Err(SourceError::Unsupported),
        "no watcher means no change source at all"
    );
    assert_eq!(
        LinuxSource::with_phase(Phase::CatchingUp).changes(root, SnapshotId::new(0)),
        Err(SourceError::NotReady),
        "catching up is temporary, not unsupported"
    );
    assert_eq!(
        LinuxSource::with_phase(live).changes(root, SnapshotId::new(0)),
        Err(SourceError::Unsupported),
        "even a Live phase has no replay buffer until L2"
    );
}
