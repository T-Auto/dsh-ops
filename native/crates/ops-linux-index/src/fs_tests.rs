use super::*;
use crate::source::{LinuxSource, Phase};
use ops_index::{FsDataSource, SnapshotId, SourceState};
use std::path::Path;

const SAMPLE: &str = "\
/dev/sda1 / ext4 rw,relatime 0 0
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0
server:/export /mnt/nfs nfs4 rw,relatime,vers=4.2,rsize=1048576 0 0
sshfs#host:/ /home/user/ssh fuse.sshfs rw,nosuid,nodev 0 0
tmpfs /tmp tmpfs rw,nosuid,nodev 0 0
/dev/sda1 /mnt/bind ext4 rw 0 0
";

#[test]
fn families_of_interest_are_offline() {
    for (fs_type, expected) in [
        ("nfs", UnsupportedFs::Nfs),
        ("nfs4", UnsupportedFs::Nfs),
        ("nfsd", UnsupportedFs::Nfs),
        ("fuse", UnsupportedFs::Fuse),
        ("fuse.sshfs", UnsupportedFs::Fuse),
        ("fusectl", UnsupportedFs::Fuse),
        ("proc", UnsupportedFs::Procfs),
        ("sysfs", UnsupportedFs::Sysfs),
    ] {
        assert_eq!(
            UnsupportedFs::from_fs_type(fs_type),
            Some(expected),
            "{fs_type} must be refused"
        );
    }
}

#[test]
fn local_families_stay_indexable() {
    for fs_type in [
        "ext4", "xfs", "btrfs", "tmpfs", "overlay", "zfs", "apfs", "vfat", "9p", "",
    ] {
        assert_eq!(
            UnsupportedFs::from_fs_type(fs_type),
            None,
            "{fs_type} must not be refused"
        );
    }
}

#[test]
fn codes_and_names_are_stable() {
    for (family, code, name) in [
        (UnsupportedFs::Nfs, "INDEX_FS_NFS", "nfs"),
        (UnsupportedFs::Fuse, "INDEX_FS_FUSE", "fuse"),
        (UnsupportedFs::Procfs, "INDEX_FS_PROCFS", "procfs"),
        (UnsupportedFs::Sysfs, "INDEX_FS_SYSFS", "sysfs"),
    ] {
        assert_eq!(family.code(), code);
        assert_eq!(family.name(), name);
    }
}

#[test]
fn mounts_parse_the_three_fields_this_module_needs() {
    let mounts = parse_mounts(SAMPLE);
    assert_eq!(mounts.len(), 7);
    assert_eq!(mounts[0].path, PathBuf::from("/"));
    assert_eq!(mounts[0].fs_type, "ext4");
    assert_eq!(mounts[3].path, PathBuf::from("/mnt/nfs"));
    assert_eq!(mounts[3].fs_type, "nfs4");
    assert_eq!(mounts[4].fs_type, "fuse.sshfs");
}

#[test]
fn escaped_mount_points_are_decoded() {
    let mounts = parse_mounts(
        "/dev/sda1 /mnt/with\\040space ext4 rw 0 0\n\
         /dev/sda1 /mnt/tab\\011here ext4 rw 0 0\n\
         /dev/sda1 /mnt/back\\134slash ext4 rw 0 0\n",
    );
    assert_eq!(mounts[0].path, PathBuf::from("/mnt/with space"));
    assert_eq!(mounts[1].path, PathBuf::from("/mnt/tab\there"));
    assert_eq!(mounts[2].path, PathBuf::from("/mnt/back\\slash"));
}

#[test]
fn escapes_that_are_not_three_octal_digits_stay_literal() {
    let mounts = parse_mounts("/dev/sda1 /mnt/odd\\1x ext4 rw 0 0\n");
    assert_eq!(mounts[0].path, PathBuf::from("/mnt/odd\\1x"));
    let mounts = parse_mounts("/dev/sda1 /mnt/bad\\999 ext4 rw 0 0\n");
    assert_eq!(mounts[0].path, PathBuf::from("/mnt/bad\\999"));
}

#[test]
fn malformed_and_comment_lines_are_skipped() {
    let mounts = parse_mounts(
        "\
# a comment

/dev/sda1 /
only-two fields
proc /proc proc rw 0 0
",
    );
    assert_eq!(mounts.len(), 1);
    assert_eq!(mounts[0].path, PathBuf::from("/proc"));
    assert_eq!(mounts[0].fs_type, "proc");
}

#[test]
fn classify_picks_the_longest_matching_mount_point() {
    let classification = classify_mounts(Path::new("/mnt/nfs/deep/file"), SAMPLE);
    assert_eq!(classification.mount_point(), Some(Path::new("/mnt/nfs")));
    assert_eq!(classification.fs_type(), Some("nfs4"));
    assert_eq!(classification.unsupported(), Some(UnsupportedFs::Nfs));
    assert!(classification.is_offline());

    // The bind mount over the NFS prefix wins over the shorter NFS mount.
    let classification = classify_mounts(Path::new("/mnt/bind/x"), SAMPLE);
    assert_eq!(classification.mount_point(), Some(Path::new("/mnt/bind")));
    assert_eq!(classification.fs_type(), Some("ext4"));
    assert!(!classification.is_offline());
}

#[test]
fn classify_handles_exact_mount_points_and_roots_without_an_entry() {
    let classification = classify_mounts(Path::new("/proc"), SAMPLE);
    assert_eq!(classification.mount_point(), Some(Path::new("/proc")));
    assert_eq!(classification.unsupported(), Some(UnsupportedFs::Procfs));

    let classification = classify_mounts(Path::new("/tmp/cache"), SAMPLE);
    assert_eq!(classification.mount_point(), Some(Path::new("/tmp")));
    assert_eq!(classification.unsupported(), None);

    let classification = classify_mounts(Path::new("/not/in/table"), "proc /proc proc rw 0 0\n");
    assert_eq!(classification.mount_point(), None);
    assert_eq!(classification.fs_type(), None);
    assert_eq!(classification.unsupported(), None);
    assert!(!classification.is_offline());
}

#[test]
fn classify_reports_each_offline_family() {
    for (root, expected) in [
        ("/proc/self", UnsupportedFs::Procfs),
        ("/sys/kernel", UnsupportedFs::Sysfs),
        ("/mnt/nfs/x", UnsupportedFs::Nfs),
        ("/home/user/ssh/x", UnsupportedFs::Fuse),
    ] {
        let classification = classify_mounts(Path::new(root), SAMPLE);
        assert_eq!(
            classification.unsupported(),
            Some(expected),
            "{root} must be offline"
        );
        assert!(classification.is_offline());
    }
    for root in ["/", "/tmp/x", "/mnt/bind/y"] {
        assert!(
            !classify_mounts(Path::new(root), SAMPLE).is_offline(),
            "{root} must stay indexable"
        );
    }
}

#[test]
fn the_real_mount_table_classifies_proc_and_sys_offline() {
    let proc_root = classify_root(Path::new("/proc")).expect("read the kernel mount table");
    assert_eq!(proc_root.unsupported(), Some(UnsupportedFs::Procfs));
    assert!(proc_root.is_offline());

    let sys_root = classify_root(Path::new("/sys")).expect("read the kernel mount table");
    assert_eq!(sys_root.unsupported(), Some(UnsupportedFs::Sysfs));
    assert!(sys_root.is_offline());

    let root = classify_root(Path::new("/")).expect("read the kernel mount table");
    assert!(root.fs_type().is_some());
    assert!(!root.is_offline());
}

#[test]
fn source_reports_offline_for_a_pseudo_file_system_root() {
    let live = LinuxSource::with_phase(Phase::Live {
        snapshot: SnapshotId::new(7),
        consistent_at_ms: 1000,
    });
    // Even a caught-up watcher cannot serve a procfs root: there is no local
    // identity to keep consistent, so the state is Offline (Unavailable).
    assert_eq!(live.state(Path::new("/proc")), SourceState::Unavailable);
    assert_eq!(live.state(Path::new("/sys")), SourceState::Unavailable);
    assert_eq!(
        LinuxSource::new().state(Path::new("/proc")),
        SourceState::Unavailable,
        "an unwatched source is still Offline, never merely Unsupported, on procfs"
    );
}

#[test]
fn source_keeps_the_phase_state_for_an_indexable_root() {
    let live = LinuxSource::with_phase(Phase::Live {
        snapshot: SnapshotId::new(7),
        consistent_at_ms: 1000,
    });
    assert_eq!(
        live.state(Path::new("/tmp")),
        SourceState::Ready {
            snapshot: SnapshotId::new(7),
            consistent_at_ms: 1000,
        }
    );
    assert_eq!(
        LinuxSource::new().state(Path::new("/tmp")),
        SourceState::Unsupported
    );
}
