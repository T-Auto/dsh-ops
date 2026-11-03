use super::*;
use crate::ids::{EntryId, NameId, VolumeId};
use crate::source::EntryKind;
use std::mem::size_of;

fn header(generation: u64) -> SnapshotHeader {
    SnapshotHeader {
        identity: SnapshotIdentity {
            volume_id: VolumeId::new(0x1234_5678_9ABC_DEF0),
            root_dev: 55,
            root_ino: 77,
        },
        generation,
        consistent_at_ms: -123,
    }
}

fn sample() -> Snapshot {
    let names = vec![
        b"docs".to_vec(),
        b"report.txt".to_vec(),
        b"sub".to_vec(),
        vec![0xFF, 0xFE, 0x00],
    ];
    let records = vec![
        SnapshotRecord::new(EntryId::NIL, NameId::new(0), EntryKind::Dir, 0, Some(0)),
        SnapshotRecord::new(
            EntryId::new(0),
            NameId::new(1),
            EntryKind::File,
            42,
            Some(-5),
        ),
        SnapshotRecord::new(EntryId::new(0), NameId::new(2), EntryKind::Dir, 4096, None),
        SnapshotRecord::new(
            EntryId::new(2),
            NameId::new(3),
            EntryKind::Link,
            u64::MAX,
            Some(i64::MAX),
        ),
        SnapshotRecord::new(EntryId::new(2), NameId::new(0), EntryKind::Other, 7, None),
    ];
    Snapshot::new(header(9), records, names).expect("sample snapshot is valid")
}

fn sample_bytes() -> Vec<u8> {
    sample().encode().expect("sample snapshot encodes")
}

fn decode_error(bytes: &[u8]) -> FormatError {
    Snapshot::decode(bytes).expect_err("snapshot must be rejected")
}

fn names_bytes(snapshot: &Snapshot) -> usize {
    snapshot.names().iter().map(|name| 4 + name.len()).sum()
}

fn patch_u16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn patch_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn patch_u64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn patch_i64(bytes: &mut [u8], offset: usize, value: i64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn reseal(bytes: &mut [u8]) {
    let crc = checksum(bytes);
    patch_u32(bytes, CRC_OFFSET, crc);
}

#[test]
fn record_layout_is_compact_and_header_is_fixed() {
    assert_eq!(HEADER_LEN, 88);
    assert_eq!(RECORD_LEN, 26);
    assert_eq!(MAX_RECORD_LEN, 32);
    let record_size = size_of::<SnapshotRecord>();
    assert!(
        (24..=MAX_RECORD_LEN).contains(&record_size),
        "compact record is {record_size} bytes"
    );
    assert_eq!(MAGIC, *b"DSHOPIDX");
}

#[test]
fn round_trip_preserves_header_records_and_raw_names() {
    let snapshot = sample();
    let bytes = snapshot.encode().expect("encodes");
    assert_eq!(
        bytes.len(),
        HEADER_LEN + snapshot.record_count() * RECORD_LEN + names_bytes(&snapshot)
    );

    let decoded = Snapshot::decode(&bytes).expect("decodes");
    assert_eq!(decoded, snapshot);
    assert_eq!(decoded.header(), header(9));
    assert_eq!(decoded.header().consistent_at_ms, -123);
    assert_eq!(decoded.record_count(), 5);
    assert_eq!(decoded.name_count(), 4);
    assert_eq!(decoded.names()[3], vec![0xFF, 0xFE, 0x00]);
    assert_eq!(decoded.records()[3].kind(), EntryKind::Link);
    assert_eq!(decoded.records()[3].size(), u64::MAX);
    assert_eq!(decoded.records()[3].modified_ns(), Some(i64::MAX));
    assert_eq!(decoded.records()[2].modified_ns(), None);
    assert!(decoded.records()[0].parent().is_nil());

    assert_eq!(decoded.encode().expect("re-encodes"), bytes);
}

#[test]
fn empty_snapshot_round_trips_to_a_header_only_file() {
    let snapshot = Snapshot::new(header(0), Vec::new(), Vec::new()).expect("valid empty snapshot");
    let bytes = snapshot.encode().expect("encodes");
    assert_eq!(bytes.len(), HEADER_LEN);
    assert_eq!(Snapshot::decode(&bytes).expect("decodes"), snapshot);
}

#[test]
fn encoding_is_deterministic() {
    let snapshot = sample();
    let first = snapshot.encode().expect("encodes");
    let second = snapshot.encode().expect("encodes again");
    assert_eq!(first, second);
    assert_eq!(snapshot.clone().encode().expect("clone encodes"), first);
}

#[test]
fn crc_matches_the_ieee_check_vector() {
    assert_eq!(crc32(b""), 0);
    assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    assert_eq!(crc32(b"performance"), 0x82D7_9681);
    assert_eq!(
        crc32(b"The quick brown fox jumps over the lazy dog"),
        0x414F_A339
    );
}

#[test]
fn magic_version_schema_lengths_and_reserved_are_checked() {
    let mut bytes = sample_bytes();
    bytes[0] ^= 0xFF;
    assert_eq!(decode_error(&bytes), FormatError::BadMagic);

    let mut bytes = sample_bytes();
    patch_u32(&mut bytes, VERSION_OFFSET, VERSION + 1);
    assert_eq!(
        decode_error(&bytes),
        FormatError::UnsupportedVersion { found: VERSION + 1 }
    );

    let mut bytes = sample_bytes();
    patch_u32(&mut bytes, SCHEMA_OFFSET, SCHEMA + 1);
    assert_eq!(
        decode_error(&bytes),
        FormatError::UnsupportedSchema { found: SCHEMA + 1 }
    );

    let mut bytes = sample_bytes();
    patch_u32(&mut bytes, HEADER_LEN_OFFSET, HEADER_LEN as u32 + 1);
    assert_eq!(
        decode_error(&bytes),
        FormatError::BadHeaderLength {
            found: HEADER_LEN as u32 + 1
        }
    );

    let mut bytes = sample_bytes();
    patch_u32(&mut bytes, RECORD_LEN_OFFSET, RECORD_LEN as u32 + 1);
    assert_eq!(
        decode_error(&bytes),
        FormatError::BadRecordLength {
            found: RECORD_LEN as u32 + 1
        }
    );

    let mut bytes = sample_bytes();
    patch_u32(&mut bytes, RESERVED_OFFSET, 7);
    assert_eq!(decode_error(&bytes), FormatError::BadReserved { found: 7 });
}

#[test]
fn every_truncation_prefix_is_rejected_without_panicking() {
    let bytes = sample_bytes();
    let cases = [
        0,
        1,
        7,
        8,
        11,
        12,
        40,
        HEADER_LEN - 1,
        HEADER_LEN,
        HEADER_LEN + RECORD_LEN - 1,
        bytes.len() - 1,
    ];
    for length in cases {
        let error = decode_error(&bytes[..length]);
        assert!(
            matches!(error, FormatError::Truncated { .. }),
            "prefix {length} should be truncated, got {error:?}"
        );
    }
    for length in 0..bytes.len() {
        let _ = Snapshot::decode(&bytes[..length]);
    }
}

#[test]
fn truncated_payload_reports_the_exact_contract_offsets() {
    let bytes = sample_bytes();
    assert_eq!(
        decode_error(&bytes[..HEADER_LEN]),
        FormatError::Truncated {
            what: "SNAPSHOT_PAYLOAD",
            offset: HEADER_LEN,
            need: bytes.len() - HEADER_LEN,
            len: HEADER_LEN,
        }
    );
}

#[test]
fn trailing_bytes_are_a_length_mismatch() {
    let mut bytes = sample_bytes();
    let expected = bytes.len();
    bytes.push(0);
    assert_eq!(
        decode_error(&bytes),
        FormatError::LengthMismatch {
            expected,
            found: expected + 1,
        }
    );
}

#[test]
fn crc_corruption_is_rejected_in_header_and_payload() {
    for offset in [
        VOLUME_OFFSET,
        GENERATION_OFFSET,
        TIMESTAMP_OFFSET,
        HEADER_LEN,
        HEADER_LEN + RECORD_LEN + 3,
        CRC_OFFSET,
    ] {
        let mut bytes = sample_bytes();
        bytes[offset] ^= 0x80;
        let error = decode_error(&bytes);
        assert!(
            matches!(error, FormatError::BadCrc { .. }),
            "offset {offset} should fail CRC, got {error:?}"
        );
    }
}

#[test]
fn unknown_flags_are_rejected() {
    let mut bytes = sample_bytes();
    let offset = HEADER_LEN + 8;
    let flags = read_u16(&bytes, offset);
    patch_u16(&mut bytes, offset, flags | 0b1000);
    reseal(&mut bytes);
    assert_eq!(
        decode_error(&bytes),
        FormatError::BadFlags {
            record: 0,
            flags: flags | 0b1000,
        }
    );
}

#[test]
fn a_timestamp_without_the_present_flag_is_rejected() {
    let mut bytes = sample_bytes();
    let offset = HEADER_LEN + 8;
    let flags = read_u16(&bytes, offset) & !HAS_MTIME;
    patch_u16(&mut bytes, offset, flags);
    patch_i64(&mut bytes, HEADER_LEN + 18, 99);
    reseal(&mut bytes);
    assert_eq!(
        decode_error(&bytes),
        FormatError::UnexpectedTimestamp { record: 0 }
    );
}

#[test]
fn dangling_name_and_parent_references_are_rejected() {
    let mut bytes = sample_bytes();
    patch_u32(&mut bytes, HEADER_LEN + 4, 4);
    reseal(&mut bytes);
    assert_eq!(
        decode_error(&bytes),
        FormatError::BadNameId {
            record: 0,
            name_id: 4,
            names: 4,
        }
    );

    let mut bytes = sample_bytes();
    patch_u32(&mut bytes, HEADER_LEN + RECORD_LEN, 5);
    reseal(&mut bytes);
    assert_eq!(
        decode_error(&bytes),
        FormatError::BadParent {
            record: 1,
            parent: 5,
            records: 5,
        }
    );

    let invalid = Snapshot::new(
        header(1),
        vec![SnapshotRecord::new(
            EntryId::new(3),
            NameId::new(0),
            EntryKind::File,
            0,
            None,
        )],
        vec![b"only-name".to_vec()],
    );
    assert_eq!(
        invalid.expect_err("dangling parent is rejected at construction"),
        FormatError::BadParent {
            record: 0,
            parent: 3,
            records: 1,
        }
    );
}

#[test]
fn impossible_counts_are_rejected_before_allocating() {
    let mut bytes = sample_bytes();
    patch_u32(&mut bytes, RECORD_COUNT_OFFSET, u32::MAX);
    assert!(matches!(
        decode_error(&bytes),
        FormatError::Truncated { .. } | FormatError::TooLarge { .. }
    ));

    let mut bytes = sample_bytes();
    patch_u64(&mut bytes, NAME_BYTES_OFFSET, u64::MAX);
    assert!(matches!(decode_error(&bytes), FormatError::TooLarge { .. }));

    let mut bytes = sample_bytes();
    patch_u32(&mut bytes, NAME_COUNT_OFFSET, 3);
    reseal(&mut bytes);
    assert!(matches!(
        decode_error(&bytes),
        FormatError::LengthMismatch { .. }
    ));

    let mut bytes = sample_bytes();
    patch_u32(&mut bytes, NAME_COUNT_OFFSET, 5);
    reseal(&mut bytes);
    assert!(matches!(
        decode_error(&bytes),
        FormatError::Truncated { .. }
    ));
}

#[test]
fn huge_name_count_without_name_bytes_is_rejected_without_a_large_allocation() {
    let snapshot = sample();
    let records_len = snapshot.record_count() * RECORD_LEN;
    let mut bytes = sample_bytes();
    bytes.truncate(HEADER_LEN + records_len);
    patch_u32(&mut bytes, NAME_COUNT_OFFSET, u32::MAX);
    patch_u64(&mut bytes, NAME_BYTES_OFFSET, 0);
    reseal(&mut bytes);
    assert!(matches!(
        decode_error(&bytes),
        FormatError::Truncated { .. }
    ));
}

#[test]
fn every_byte_corruption_is_handled_without_panicking() {
    let bytes = sample_bytes();
    for offset in 0..bytes.len() {
        let mut copy = bytes.clone();
        copy[offset] ^= 0xFF;
        let _ = Snapshot::decode(&copy);
    }
}

#[test]
fn record_constructor_maps_every_kind_and_timestamp() {
    let cases = [
        (EntryKind::File, 0),
        (EntryKind::Dir, 1),
        (EntryKind::Link, 2),
        (EntryKind::Other, 3),
    ];
    for (kind, code) in cases {
        let record = SnapshotRecord::new(EntryId::new(7), NameId::new(9), kind, 123, Some(-456));
        assert_eq!(record.kind(), kind);
        assert_eq!(kind_code(kind), code);
        assert_eq!(record.parent(), EntryId::new(7));
        assert_eq!(record.name_id(), NameId::new(9));
        assert_eq!(record.size(), 123);
        assert_eq!(record.modified_ns(), Some(-456));
    }

    let absent = SnapshotRecord::new(EntryId::NIL, NameId::new(0), EntryKind::Dir, 0, None);
    assert_eq!(absent.modified_ns(), None);
    let epoch = SnapshotRecord::new(EntryId::NIL, NameId::new(0), EntryKind::Dir, 0, Some(0));
    assert_eq!(epoch.modified_ns(), Some(0));
}

#[test]
fn errors_expose_stable_codes_and_messages() {
    let cases: [(FormatError, &str); 12] = [
        (FormatError::BadMagic, "INDEX_SNAPSHOT_MAGIC"),
        (
            FormatError::UnsupportedVersion { found: 2 },
            "INDEX_SNAPSHOT_VERSION",
        ),
        (
            FormatError::UnsupportedSchema { found: 2 },
            "INDEX_SNAPSHOT_SCHEMA",
        ),
        (
            FormatError::BadHeaderLength { found: 1 },
            "INDEX_SNAPSHOT_HEADER",
        ),
        (
            FormatError::BadRecordLength { found: 1 },
            "INDEX_SNAPSHOT_HEADER",
        ),
        (
            FormatError::BadReserved { found: 1 },
            "INDEX_SNAPSHOT_HEADER",
        ),
        (
            FormatError::Truncated {
                what: "SNAPSHOT",
                offset: 0,
                need: 4,
                len: 2,
            },
            "INDEX_SNAPSHOT_TRUNCATED",
        ),
        (
            FormatError::LengthMismatch {
                expected: 10,
                found: 11,
            },
            "INDEX_SNAPSHOT_LENGTH",
        ),
        (
            FormatError::BadCrc {
                expected: 1,
                found: 2,
            },
            "INDEX_SNAPSHOT_CRC",
        ),
        (
            FormatError::BadFlags {
                record: 0,
                flags: 8,
            },
            "INDEX_SNAPSHOT_RECORD",
        ),
        (
            FormatError::BadNameId {
                record: 0,
                name_id: 2,
                names: 1,
            },
            "INDEX_SNAPSHOT_NAME_ID",
        ),
        (
            FormatError::BadParent {
                record: 0,
                parent: 2,
                records: 1,
            },
            "INDEX_SNAPSHOT_PARENT",
        ),
    ];
    for (error, code) in cases {
        assert_eq!(error.code(), code);
        assert!(!error.to_string().is_empty());
        let dynamic: &dyn std::error::Error = &error;
        assert!(dynamic.source().is_none());
    }
}
