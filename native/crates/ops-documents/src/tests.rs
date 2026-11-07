use super::*;
fn fixture_name(timestamp: u128) -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let sequence = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("dsh-table-{}-{timestamp}-{sequence}", std::process::id())
}
#[test]
fn fixture_names_are_distinct_even_with_identical_timestamps() {
    let names: std::collections::HashSet<_> = (0..64).map(|_| fixture_name(42)).collect();
    assert_eq!(names.len(), 64);
}
fn fixture(test: impl FnOnce(PathBuf, Request, Args)) {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(fixture_name(unique));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("table.csv");
    std::fs::write(&path, "v\nsafe\n").unwrap();
    let request = serde_json::from_value(
        json!({"root":root,"scope":"table-unit","tool":"read_table","args":{}}),
    )
    .unwrap();
    let args = serde_json::from_value(json!({"path":path})).unwrap();
    test(path, request, args);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn expired_scan_deadline_has_no_total_revision_or_complete_claim() {
    fixture(|path, request, args| {
        let file = File::open(&path).unwrap();
        let before = file.metadata().unwrap();
        let source = Source {
            path,
            file,
            before,
            started: Instant::now() - Duration::from_secs(31),
        };
        let output = observe(&request, &args, "csv", Encoding::Utf8, ',', source).unwrap();
        assert_eq!(output["status"], "partial");
        assert_eq!(output["error"]["code"], "DEADLINE_EXCEEDED");
        assert_eq!(output["scanComplete"], false);
        assert_eq!(output["rowsObserved"], 0);
        assert!(output.get("rowCount").is_none());
        assert!(output.get("revision").is_none());
    });
}
#[test]
fn changed_file_metadata_invalidates_totals_without_discarding_safe_rows() {
    fixture(|path, request, mut args| {
        args.limit = 1;
        let file = File::open(&path).unwrap();
        let before = file.metadata().unwrap();
        std::fs::write(&path, "v\nchanged-long\n").unwrap();
        let source = Source {
            path,
            file,
            before,
            started: Instant::now(),
        };
        let output = observe(&request, &args, "csv", Encoding::Utf8, ',', source).unwrap();
        assert_eq!(output["error"]["code"], "FILE_CHANGED");
        assert_eq!(output["scanComplete"], false);
        assert_eq!(output["complete"], false);
        assert_eq!(output["pageComplete"], false);
        assert_eq!(output["items"][0]["cells"][0], "changed-long");
        assert!(output.get("total").is_none());
        assert!(output.get("revision").is_none());
    });
}

#[test]
fn short_reads_do_not_bypass_bom_or_unicode_validation() {
    struct OneByte(std::io::Cursor<Vec<u8>>);
    impl std::io::Read for OneByte {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            let count = bytes.len().min(1);
            std::io::Read::read(&mut self.0, &mut bytes[..count])
        }
    }
    let reader = |bytes: Vec<u8>| OneByte(std::io::Cursor::new(bytes));
    assert!(Decoder::new(reader(vec![0xef, 0xbb, 0xbf, b'x']), Encoding::Utf16Be).is_err());
    assert!(Decoder::new(reader(vec![0xff, 0xfe, b'x', 0]), Encoding::Utf8).is_err());
    let mut valid =
        Decoder::new(reader("\u{feff}中😀".as_bytes().to_vec()), Encoding::Utf8).unwrap();
    assert_eq!(valid.next().unwrap(), Some('中'));
    assert_eq!(valid.next().unwrap(), Some('😀'));
    assert_eq!(valid.next().unwrap(), None);
    let mut invalid = Decoder::new(reader(vec![0xf0, 0x9f]), Encoding::Utf8).unwrap();
    assert_eq!(invalid.next().unwrap_err().code, "ERR_INVALID_ENCODING");
}
