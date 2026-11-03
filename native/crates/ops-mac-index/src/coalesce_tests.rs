use super::*;
use ops_index::ChangeAction;
use std::path::PathBuf;

fn roots() -> Vec<PathBuf> {
    vec![PathBuf::from("/root")]
}

fn event(id: u64, flags: EventFlags, path: &str) -> Event {
    Event {
        id: EventId::from_raw(id),
        flags,
        path: PathBuf::from(path),
        file_id: None,
    }
}

fn identified(mut event: Event, file_id: u64) -> Event {
    event.file_id = Some(file_id);
    event
}

fn probe(present: &[&str]) -> impl Fn(&Path) -> bool + '_ {
    let present: Vec<PathBuf> = present.iter().map(PathBuf::from).collect();
    move |path: &Path| present.iter().any(|candidate| candidate == path)
}

#[test]
fn a_single_create_is_an_added_change() {
    let events = [event(3, EventFlags::ITEM_CREATED, "/root/a.txt")];
    let batch = coalesce_with(&events, &roots(), |_| false);
    assert_eq!(
        batch.changes,
        vec![CoalescedChange {
            rel: PathBuf::from("a.txt"),
            action: ChangeAction::Added,
            file_id: None,
            id: EventId::from_raw(3),
        }]
    );
    assert_eq!(batch.latest, Some(EventId::from_raw(3)));
    assert_eq!(batch.ignored, 0);
    assert_eq!(batch.excluded, 0);
}

#[test]
fn repeated_modifies_collapse_to_one_modified_change() {
    let events = [
        event(3, EventFlags::ITEM_MODIFIED, "/root/a.txt"),
        event(4, EventFlags::ITEM_XATTR_MOD, "/root/a.txt"),
        event(9, EventFlags::ITEM_INODE_META_MOD, "/root/a.txt"),
    ];
    let batch = coalesce_with(&events, &roots(), |_| false);
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(batch.changes[0].action, ChangeAction::Modified);
    assert_eq!(batch.changes[0].id, EventId::from_raw(9));
    assert_eq!(batch.latest, Some(EventId::from_raw(9)));
}

#[test]
fn create_then_modify_stays_an_addition() {
    let events = [
        event(3, EventFlags::ITEM_CREATED, "/root/a.txt"),
        event(4, EventFlags::ITEM_MODIFIED, "/root/a.txt"),
    ];
    let batch = coalesce_with(&events, &roots(), |_| false);
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(batch.changes[0].action, ChangeAction::Added);
    assert_eq!(batch.changes[0].id, EventId::from_raw(4));
}

#[test]
fn create_then_remove_is_a_removal() {
    let events = [
        event(3, EventFlags::ITEM_CREATED, "/root/a.txt"),
        event(4, EventFlags::ITEM_REMOVED, "/root/a.txt"),
    ];
    let batch = coalesce_with(&events, &roots(), |_| false);
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(batch.changes[0].action, ChangeAction::Removed);
}

#[test]
fn remove_then_create_is_a_modification() {
    let events = [
        event(3, EventFlags::ITEM_REMOVED, "/root/a.txt"),
        event(4, EventFlags::ITEM_CREATED, "/root/a.txt"),
    ];
    let batch = coalesce_with(&events, &roots(), |_| false);
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(batch.changes[0].action, ChangeAction::Modified);
    assert_eq!(batch.changes[0].id, EventId::from_raw(4));
}

#[test]
fn events_outside_every_root_are_ignored() {
    let events = [
        event(3, EventFlags::ITEM_CREATED, "/elsewhere/a.txt"),
        event(4, EventFlags::ITEM_CREATED, "/root/b.txt"),
    ];
    let batch = coalesce_with(&events, &roots(), |_| false);
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(batch.changes[0].rel, PathBuf::from("b.txt"));
    assert_eq!(batch.ignored, 1);
    // The ignored event still counts towards the cursor.
    assert_eq!(batch.latest, Some(EventId::from_raw(4)));
}

#[test]
fn paths_are_relative_to_the_longest_root() {
    let roots = vec![PathBuf::from("/root"), PathBuf::from("/root/sub")];
    let events = [event(3, EventFlags::ITEM_CREATED, "/root/sub/deep.txt")];
    let batch = coalesce_with(&events, &roots, |_| false);
    assert_eq!(batch.changes[0].rel, PathBuf::from("deep.txt"));
}

#[test]
fn a_rename_pair_with_a_file_id_becomes_one_renamed_change() {
    let events = [
        identified(
            event(5, EventFlags::ITEM_RENAMED, "/root/old.txt"),
            9,
        ),
        identified(
            event(5, EventFlags::ITEM_RENAMED, "/root/new.txt"),
            9,
        ),
    ];
    let batch = coalesce_with(&events, &roots(), probe(&["/root/new.txt"]));
    assert_eq!(
        batch.changes,
        vec![CoalescedChange {
            rel: PathBuf::from("new.txt"),
            action: ChangeAction::Renamed,
            file_id: Some(9),
            id: EventId::from_raw(5),
        }]
    );
}

#[test]
fn a_rename_pair_without_a_file_id_falls_back_to_remove_and_add() {
    let events = [
        event(5, EventFlags::ITEM_RENAMED, "/root/old.txt"),
        event(5, EventFlags::ITEM_RENAMED, "/root/new.txt"),
    ];
    let batch = coalesce_with(&events, &roots(), probe(&["/root/new.txt"]));
    assert_eq!(batch.changes.len(), 2);
    let removed = batch
        .changes
        .iter()
        .find(|change| change.rel == PathBuf::from("old.txt"))
        .expect("the vanished name is a removal");
    assert_eq!(removed.action, ChangeAction::Removed);
    let added = batch
        .changes
        .iter()
        .find(|change| change.rel == PathBuf::from("new.txt"))
        .expect("the existing name is a modification");
    assert_eq!(added.action, ChangeAction::Modified);
}

#[test]
fn an_ambiguous_rename_falls_back_to_existence_per_path() {
    // Both names still exist (or neither does): the direction is unknowable, so
    // each path is treated by its own existence instead of inventing a move.
    let events = [
        identified(event(5, EventFlags::ITEM_RENAMED, "/root/old.txt"), 9),
        identified(event(5, EventFlags::ITEM_RENAMED, "/root/new.txt"), 9),
    ];
    let batch = coalesce_with(&events, &roots(), probe(&["/root/old.txt", "/root/new.txt"]));
    assert_eq!(batch.changes.len(), 2);
    assert!(
        batch
            .changes
            .iter()
            .all(|change| change.action == ChangeAction::Modified)
    );
}

#[test]
fn a_recreated_old_name_cancels_the_rename_suppression() {
    let events = [
        identified(event(5, EventFlags::ITEM_RENAMED, "/root/old.txt"), 9),
        identified(event(5, EventFlags::ITEM_RENAMED, "/root/new.txt"), 9),
        event(6, EventFlags::ITEM_CREATED, "/root/old.txt"),
    ];
    // The rename is resolvable (only the new name exists); the later creation
    // of the old name must then produce its own change instead of staying
    // suppressed by the rename.
    let batch = coalesce_with(&events, &roots(), probe(&["/root/new.txt"]));
    assert_eq!(batch.changes.len(), 2);
    let renamed = batch
        .changes
        .iter()
        .find(|change| change.rel == PathBuf::from("new.txt"))
        .expect("the new name is the rename");
    assert_eq!(renamed.action, ChangeAction::Renamed);
    let recreated = batch
        .changes
        .iter()
        .find(|change| change.rel == PathBuf::from("old.txt"))
        .expect("the recreated old name is a change again");
    assert_eq!(recreated.action, ChangeAction::Added);
}

#[test]
fn history_done_and_invalidating_events_are_not_changes() {
    let events = [
        event(
            3,
            EventFlags::from_raw(EventFlags::HISTORY_DONE.raw() | EventFlags::ITEM_IS_DIR.raw()),
            "/root",
        ),
        event(4, EventFlags::MUST_SCAN_SUBDIRS, "/root"),
        event(5, EventFlags::ITEM_CREATED, "/root/a.txt"),
    ];
    let batch = coalesce_with(&events, &roots(), |_| false);
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(batch.changes[0].rel, PathBuf::from("a.txt"));
    assert_eq!(batch.latest, Some(EventId::from_raw(5)));
}

#[test]
fn events_under_a_time_machine_mount_are_excluded() {
    let events = [
        event(
            3,
            EventFlags::ITEM_CREATED,
            "/Volumes/com.apple.TimeMachine.localsnapshots/Backups.backupdb/x",
        ),
        event(4, EventFlags::ITEM_CREATED, "/root/a.txt"),
    ];
    let roots = vec![PathBuf::from("/"), PathBuf::from("/root")];
    let batch = coalesce_with(&events, &roots, |_| false);
    assert_eq!(batch.changes.len(), 1);
    assert_eq!(batch.changes[0].rel, PathBuf::from("root/a.txt"));
    assert_eq!(batch.excluded, 1);
}

#[test]
fn empty_input_yields_no_changes() {
    let batch = coalesce_with(&[], &roots(), |_| false);
    assert!(batch.is_empty());
    assert_eq!(batch.latest, None);
    assert_eq!(batch.ignored, 0);
    assert_eq!(batch.excluded, 0);
}

#[test]
fn changes_are_ordered_by_id_and_then_path() {
    let events = [
        event(7, EventFlags::ITEM_CREATED, "/root/b.txt"),
        event(7, EventFlags::ITEM_CREATED, "/root/a.txt"),
        event(3, EventFlags::ITEM_CREATED, "/root/c.txt"),
    ];
    let batch = coalesce_with(&events, &roots(), |_| false);
    let order: Vec<&Path> = batch
        .changes
        .iter()
        .map(|change| change.rel.as_path())
        .collect();
    assert_eq!(
        order,
        vec![Path::new("c.txt"), Path::new("a.txt"), Path::new("b.txt")]
    );
}
