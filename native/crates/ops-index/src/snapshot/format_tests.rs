use super::*;
use crate::ids::{FileKey, RecordId, VolumeId};

fn name(bytes: &[u8]) -> Vec<u8> {
    bytes.to_vec()
}

/// WTF-8 for the UTF-16 sequence [0x0061, 0xD800, 0x0062]: "a" + an unpaired
/// high surrogate + "b". Hard-coded so this slice does not depend on P1.
fn surrogate_name() -> Vec<u8> {
    vec![0x61, 0xED, 0xA0, 0x80, 0x62]
}

fn record(
    record: u64,
    parent: u32,
    name: u32,
    flags: RecordFlags,
    size: Option<u64>,
    mtime_ns: Option<i64>,
) -> SnapshotRecord {
    SnapshotRecord {
        record: RecordId::new(record),
        parent,
        name,
        flags,
        size,
        mtime_ns,
    }
}

fn sample() -> Snapshot {
    let surrogate = surrogate_name();
    Snapshot {
        volume: VolumeId::new(0x0102_0304_0506_0708),
        root: FileKey::new(0x1111, 0x2222),
        generation: 77,
        names: vec![name(b"docs"), name(b"report.pdf"), surrogate, name(b"")],
        records: vec![
            record(1, PARENT_NIL, 0, RecordFlags::DIR, None, Some(11)),
            record(2, 0, 1, RecordFlags::EMPTY, Some(4096), Some(-5)),
            record(3, 0, 2, RecordFlags::NON_UNICODE_NAME, None, None),
            record(
                4,
                1,
                3,
                RecordFlags::DIR.with(RecordFlags::PLACEHOLDER, true),
                Some(0),
                None,
            ),
        ],
    }
}

fn header_image(
    volume: u64,
    root: FileKey,
    generation: u64,
    names: &[u8],
    records: &[u8],
) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(names);
    payload.extend_from_slice(records);
    let mut image = Vec::with_capacity(HEADER_LEN + payload.len());
    image.extend_from_slice(MAGIC);
    image.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    image.extend_from_slice(&SCHEMA_VERSION.to_le_bytes());
    image.extend_from_slice(&(HEADER_LEN as u32).to_le_bytes());
    image.extend_from_slice(&0u32.to_le_bytes());
    image.extend_from_slice(&volume.to_le_bytes());
    image.extend_from_slice(&root.volume.to_le_bytes());
    image.extend_from_slice(&root.file.to_le_bytes());
    image.extend_from_slice(&generation.to_le_bytes());
    image.extend_from_slice(&(names.len() as u64).to_le_bytes());
    image.extend_from_slice(&(records.len() as u64).to_le_bytes());
    image.extend_from_slice(&crc32(&payload).to_le_bytes());
    let header_crc = crc32(&image);
    image.extend_from_slice(&header_crc.to_le_bytes());
    image.extend_from_slice(&payload);
    image
}

fn repair_header_crc(image: &mut [u8]) {
    let crc = crc32(&image[..HEADER_LEN - 4]);
    image[HEADER_LEN - 4..HEADER_LEN].copy_from_slice(&crc.to_le_bytes());
}

fn one_name_section(raw: &[u8]) -> Vec<u8> {
    let mut section = Vec::new();
    section.extend_from_slice(&1u32.to_le_bytes());
    section.extend_from_slice(&(raw.len() as u32).to_le_bytes());
    section.extend_from_slice(raw);
    section
}

fn empty_name_section() -> Vec<u8> {
    0u32.to_le_bytes().to_vec()
}

#[test]
fn crc32_matches_the_known_answers() {
    assert_eq!(crc32(b""), 0);
    assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    assert_eq!(crc32(b"abc"), 0x3524_41C2);
}

#[test]
fn wire_constants_are_part_of_the_contract() {
    assert_eq!(HEADER_LEN, 76);
    assert_eq!(RECORD_LEN, 32);
    assert_eq!(NAME_ID_MAX, 0x0FFF_FFFF);
    assert_eq!(PARENT_NIL, u32::MAX);
    assert_eq!(MAGIC, b"DSHOPSIX");
}

#[test]
fn wire_layout_matches_the_documented_offsets() {
    let snapshot = sample();
    let image = encode(&snapshot).unwrap();
    assert_eq!(&image[..8], MAGIC);
    assert_eq!(read_u16(&image, 8), FORMAT_VERSION);
    assert_eq!(read_u16(&image, 10), SCHEMA_VERSION);
    assert_eq!(read_u32(&image, 12) as usize, HEADER_LEN);
    assert_eq!(read_u32(&image, 16), 0);
    assert_eq!(read_u64(&image, 20), snapshot.volume.get());
    assert_eq!(read_u64(&image, 28), snapshot.root.volume);
    assert_eq!(read_u64(&image, 36), snapshot.root.file);
    assert_eq!(read_u64(&image, 44), snapshot.generation);
    let names_len = read_u64(&image, 52) as usize;
    let records_len = read_u64(&image, 60) as usize;
    assert_eq!(records_len, 4 + snapshot.records.len() * RECORD_LEN);
    assert_eq!(image.len(), HEADER_LEN + names_len + records_len);
    assert_eq!(read_u32(&image, 68), crc32(&image[HEADER_LEN..]));
    assert_eq!(read_u32(&image, 72), crc32(&image[..72]));
    assert_eq!(read_u32(&image, HEADER_LEN), 4);
}

#[test]
fn full_snapshot_round_trips() {
    let snapshot = sample();
    let image = encode(&snapshot).unwrap();
    assert_eq!(decode(&image).unwrap(), snapshot);
}

#[test]
fn names_with_unpaired_surrogates_survive_byte_for_byte() {
    let snapshot = sample();
    let image = encode(&snapshot).unwrap();
    let decoded = decode(&image).unwrap();
    assert_eq!(decoded.names[2], surrogate_name());
    assert_eq!(decoded.records[2].flags, RecordFlags::NON_UNICODE_NAME);
}

#[test]
fn empty_snapshot_round_trips() {
    let snapshot = Snapshot {
        volume: VolumeId::new(9),
        root: FileKey::new(8, 7),
        generation: 0,
        names: Vec::new(),
        records: Vec::new(),
    };
    let image = encode(&snapshot).unwrap();
    assert_eq!(image.len(), HEADER_LEN + 4 + 4);
    assert_eq!(decode(&image).unwrap(), snapshot);
}

#[test]
fn encoding_is_deterministic() {
    let snapshot = sample();
    assert_eq!(encode(&snapshot).unwrap(), encode(&snapshot).unwrap());
}

#[test]
fn short_headers_are_truncated_errors() {
    for length in 0..HEADER_LEN {
        let image = vec![0u8; length];
        match decode(&image) {
            Err(SnapshotError::Truncated {
                what,
                offset,
                need,
                len,
            }) => {
                assert_eq!(what, "header");
                assert_eq!(offset, 0);
                assert_eq!(need, HEADER_LEN);
                assert_eq!(len, length);
            }
            other => panic!("length {length} decoded as {other:?}"),
        }
    }
}

#[test]
fn wrong_magic_is_rejected() {
    let mut image = encode(&sample()).unwrap();
    image[0] = b'X';
    assert_eq!(decode(&image), Err(SnapshotError::BadMagic));
}

#[test]
fn format_and_schema_versions_are_rejected() {
    let mut image = encode(&sample()).unwrap();
    image[8..10].copy_from_slice(&(FORMAT_VERSION + 1).to_le_bytes());
    repair_header_crc(&mut image);
    assert_eq!(
        decode(&image),
        Err(SnapshotError::UnsupportedFormat {
            found: FORMAT_VERSION + 1,
            expected: FORMAT_VERSION,
        })
    );
    let mut image = encode(&sample()).unwrap();
    image[10..12].copy_from_slice(&(SCHEMA_VERSION + 1).to_le_bytes());
    repair_header_crc(&mut image);
    assert_eq!(
        decode(&image),
        Err(SnapshotError::UnsupportedSchema {
            found: SCHEMA_VERSION + 1,
            expected: SCHEMA_VERSION,
        })
    );
}

#[test]
fn bad_header_fields_are_rejected() {
    let mut image = encode(&sample()).unwrap();
    image[12..16].copy_from_slice(&80u32.to_le_bytes());
    repair_header_crc(&mut image);
    assert_eq!(
        decode(&image),
        Err(SnapshotError::BadHeader {
            what: "header length"
        })
    );
    let mut image = encode(&sample()).unwrap();
    image[16..20].copy_from_slice(&1u32.to_le_bytes());
    repair_header_crc(&mut image);
    assert_eq!(
        decode(&image),
        Err(SnapshotError::BadHeader {
            what: "reserved flags"
        })
    );
}

#[test]
fn header_and_payload_crc_mismatches_are_rejected() {
    let mut image = encode(&sample()).unwrap();
    image[44] ^= 0xFF;
    let found = read_u32(&image, 72);
    let expected = crc32(&image[..72]);
    assert_eq!(
        decode(&image),
        Err(SnapshotError::HeaderCrcMismatch { found, expected })
    );
    let mut image = encode(&sample()).unwrap();
    let last = image.len() - 1;
    image[last] ^= 0xFF;
    let found = read_u32(&image, 68);
    let expected = crc32(&image[HEADER_LEN..]);
    assert_eq!(
        decode(&image),
        Err(SnapshotError::PayloadCrcMismatch { found, expected })
    );
}

#[test]
fn declared_sections_must_fit_the_buffer() {
    let mut image = encode(&sample()).unwrap();
    let names_len = read_u64(&image, 52);
    image[52..60].copy_from_slice(&(names_len + 1000).to_le_bytes());
    repair_header_crc(&mut image);
    assert!(matches!(
        decode(&image),
        Err(SnapshotError::Truncated {
            what: "name section",
            ..
        })
    ));
}

#[test]
fn trailing_bytes_are_rejected() {
    let mut image = encode(&sample()).unwrap();
    image.push(0);
    assert!(matches!(
        decode(&image),
        Err(SnapshotError::TrailingData { .. })
    ));
}

#[test]
fn a_name_section_that_is_too_short_is_truncated() {
    let image = header_image(1, FileKey::new(1, 1), 0, &[0u8; 2], &empty_name_section());
    assert!(matches!(
        decode(&image),
        Err(SnapshotError::Truncated {
            what: "name count",
            ..
        })
    ));
    let image = header_image(1, FileKey::new(1, 1), 0, &empty_name_section(), &[0u8; 2]);
    assert!(matches!(
        decode(&image),
        Err(SnapshotError::Truncated {
            what: "record count",
            ..
        })
    ));
}

#[test]
fn a_name_section_must_be_consumed_exactly() {
    let mut names = vec![0u8; 4];
    names[0..4].copy_from_slice(&1u32.to_le_bytes());
    let image = header_image(1, FileKey::new(1, 1), 0, &names, &empty_name_section());
    assert!(matches!(
        decode(&image),
        Err(SnapshotError::Truncated {
            what: "name length",
            ..
        })
    ));
    let mut names = empty_name_section();
    names.push(0);
    let image = header_image(1, FileKey::new(1, 1), 0, &names, &empty_name_section());
    assert!(matches!(
        decode(&image),
        Err(SnapshotError::Malformed {
            what: "name section",
            ..
        })
    ));
}

#[test]
fn record_section_length_must_match_the_count() {
    let names = one_name_section(b"a");
    let mut records = 1u32.to_le_bytes().to_vec();
    records.extend_from_slice(&[0u8; RECORD_LEN - 4]);
    let image = header_image(1, FileKey::new(1, 1), 0, &names, &records);
    assert!(matches!(
        decode(&image),
        Err(SnapshotError::Truncated {
            what: "record section",
            ..
        })
    ));
    let mut records = 0u32.to_le_bytes().to_vec();
    records.extend_from_slice(&[0u8; 4]);
    let image = header_image(1, FileKey::new(1, 1), 0, &names, &records);
    assert!(matches!(
        decode(&image),
        Err(SnapshotError::Malformed {
            what: "record section",
            ..
        })
    ));
}

#[test]
fn record_cross_references_are_validated_on_decode() {
    let names = one_name_section(b"a");
    let mut bad_name = vec![0u8; RECORD_LEN];
    bad_name[12..16].copy_from_slice(&0u32.to_le_bytes());
    // One record but zero names: the name index cannot resolve.
    let image = header_image(1, FileKey::new(1, 1), 0, &empty_name_section(), &{
        let mut section = 1u32.to_le_bytes().to_vec();
        section.extend_from_slice(&bad_name);
        section
    });
    assert!(matches!(
        decode(&image),
        Err(SnapshotError::Malformed {
            what: "record name",
            ..
        })
    ));
    let mut bad_parent = vec![0u8; RECORD_LEN];
    bad_parent[8..12].copy_from_slice(&7u32.to_le_bytes());
    let mut records = 1u32.to_le_bytes().to_vec();
    records.extend_from_slice(&bad_parent);
    let image = header_image(1, FileKey::new(1, 1), 0, &names, &records);
    assert!(matches!(
        decode(&image),
        Err(SnapshotError::Malformed {
            what: "record parent",
            ..
        })
    ));
}

#[test]
fn encode_rejects_out_of_range_cross_references() {
    let mut snapshot = sample();
    snapshot.records[0].name = snapshot.names.len() as u32;
    assert_eq!(
        encode(&snapshot),
        Err(SnapshotError::OutOfRange { what: "name index" })
    );
    let mut snapshot = sample();
    snapshot.records[0].parent = snapshot.records.len() as u32;
    assert_eq!(
        encode(&snapshot),
        Err(SnapshotError::OutOfRange { what: "parent" })
    );
    let mut snapshot = sample();
    snapshot.records[0].name = NAME_ID_MAX + 1;
    assert_eq!(
        encode(&snapshot),
        Err(SnapshotError::OutOfRange { what: "name index" })
    );
}

#[test]
fn flags_round_trip_every_defined_bit() {
    for bits in 0..=0x0Fu8 {
        let flags = RecordFlags::from_bits(bits).unwrap();
        assert_eq!(flags.bits(), bits);
        let snapshot = Snapshot {
            volume: VolumeId::new(1),
            root: FileKey::new(1, 1),
            generation: 1,
            names: vec![name(b"x")],
            records: vec![record(1, PARENT_NIL, 0, flags, None, None)],
        };
        assert_eq!(
            decode(&encode(&snapshot).unwrap()).unwrap().records[0].flags,
            flags
        );
    }
    assert_eq!(RecordFlags::from_bits(0x10), None);
}

#[test]
fn record_segment_is_exactly_thirty_two_bytes_per_entry() {
    let snapshot = sample();
    let image = encode(&snapshot).unwrap();
    let records_len = read_u64(&image, 60) as usize;
    assert_eq!(records_len, 4 + snapshot.records.len() * 32);
    let body = &image[HEADER_LEN + read_u64(&image, 52) as usize..];
    assert_eq!(read_u32(body, 0) as usize, snapshot.records.len());
    let first = &body[4..4 + RECORD_LEN];
    assert_eq!(read_u64(first, 0), 1);
    assert_eq!(read_u32(first, 8), PARENT_NIL);
    assert_eq!(read_u32(first, 12) & NAME_ID_MAX, 0);
    assert_eq!(read_u64(first, 16), SIZE_UNKNOWN);
    assert_eq!(read_u64(first, 24) as i64, 11);
}

#[test]
fn names_must_not_contain_nul() {
    let mut snapshot = sample();
    snapshot.names = vec![b"a\0b".to_vec()];
    assert_eq!(
        encode(&snapshot),
        Err(SnapshotError::OutOfRange {
            what: "name contains NUL"
        })
    );
    // A CRC-valid image can still carry a NUL name: decode must reject it,
    // because the index arena is NUL-separated.
    let names = one_name_section(b"a\0b");
    let image = header_image(1, FileKey::new(1, 1), 0, &names, &empty_name_section());
    assert!(matches!(
        decode(&image),
        Err(SnapshotError::Malformed {
            what: "name contains NUL",
            ..
        })
    ));
}

#[test]
fn snapshot_error_codes_and_display_are_stable() {
    let errors = [
        (
            SnapshotError::Truncated {
                what: "header",
                offset: 0,
                need: 76,
                len: 3,
            },
            "INDEX_SNAPSHOT_TRUNCATED",
        ),
        (SnapshotError::BadMagic, "INDEX_SNAPSHOT_BAD_MAGIC"),
        (
            SnapshotError::UnsupportedFormat {
                found: 2,
                expected: 1,
            },
            "INDEX_SNAPSHOT_FORMAT_VERSION",
        ),
        (
            SnapshotError::UnsupportedSchema {
                found: 2,
                expected: 1,
            },
            "INDEX_SNAPSHOT_SCHEMA_VERSION",
        ),
        (
            SnapshotError::BadHeader {
                what: "header length",
            },
            "INDEX_SNAPSHOT_BAD_HEADER",
        ),
        (
            SnapshotError::HeaderCrcMismatch {
                found: 1,
                expected: 2,
            },
            "INDEX_SNAPSHOT_HEADER_CRC",
        ),
        (
            SnapshotError::PayloadCrcMismatch {
                found: 1,
                expected: 2,
            },
            "INDEX_SNAPSHOT_PAYLOAD_CRC",
        ),
        (
            SnapshotError::Malformed {
                what: "name",
                offset: 1,
            },
            "INDEX_SNAPSHOT_MALFORMED",
        ),
        (
            SnapshotError::TrailingData { offset: 1, len: 2 },
            "INDEX_SNAPSHOT_TRAILING_DATA",
        ),
        (
            SnapshotError::OutOfRange { what: "name" },
            "INDEX_SNAPSHOT_OUT_OF_RANGE",
        ),
    ];
    for (error, code) in errors {
        assert_eq!(error.code(), code);
        assert!(!error.to_string().is_empty());
        let _: &dyn std::error::Error = &error;
    }
}
