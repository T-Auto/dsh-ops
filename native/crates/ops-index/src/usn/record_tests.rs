use super::*;
use crate::ids::RecordId;
use crate::usn::fixtures::{
    PAD_BYTE, RecordFixture, build_enum_buffer, build_journal_buffer, build_v4_record_bytes,
    record_bytes,
};
use crate::wtf8;
use proptest::prelude::*;

fn id(value: u64) -> RecordId {
    RecordId::new(value)
}

fn enum_records(fixtures: &[RecordFixture]) -> Result<EnumWalk, WalkError> {
    walk_enum_buffer(&build_enum_buffer(0, fixtures))
}

fn one(fixture: RecordFixture) -> ParsedUsnRecord {
    enum_records(&[fixture])
        .unwrap()
        .records
        .into_iter()
        .next()
        .unwrap()
}

fn with_patch(fixture: RecordFixture, patch: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
    let mut bytes = record_bytes(&fixture);
    patch(&mut bytes);
    let mut buffer = 0u64.to_le_bytes().to_vec();
    buffer.extend_from_slice(&bytes);
    buffer
}

#[test]
fn v2_extracts_every_field() {
    let fixture = RecordFixture::file(id(0x1_0002_0003), id(5), "ağaç.pdf")
        .with_usn(-9)
        .with_timestamp(0x01D0_0000_0000_0000)
        .with_reason(USN_REASON_FILE_CREATE | USN_REASON_CLOSE)
        .with_attributes(0x80);
    let walk = walk_enum_buffer(&build_enum_buffer(u64::MAX - 1, &[fixture])).unwrap();
    assert_eq!(walk.next_start, u64::MAX - 1);
    assert_eq!(walk.skipped, SkipCounts::default());
    assert_eq!(walk.records.len(), 1);
    let record = &walk.records[0];
    assert_eq!(record.major_version, 2);
    assert_eq!(record.record, id(0x1_0002_0003));
    assert_eq!(record.parent, id(5));
    assert_eq!(record.usn, -9);
    assert_eq!(record.timestamp_ft, 0x01D0_0000_0000_0000);
    assert_eq!(record.reason, USN_REASON_FILE_CREATE | USN_REASON_CLOSE);
    assert_eq!(record.attributes, 0x80);
    assert_eq!(record.name, "ağaç.pdf".as_bytes());
    assert!(!record.name_lossy);
    assert!(!record.is_dir());
}

#[test]
fn v3_extracts_every_field_and_reports_is_dir() {
    let fixture = RecordFixture::dir(id(0xFFFF_0000_0000_0007), id(42), "docs")
        .with_version(3)
        .with_usn(7)
        .with_timestamp(-3)
        .with_reason(USN_REASON_RENAME_NEW_NAME);
    let record = one(fixture);
    assert_eq!(record.major_version, 3);
    assert_eq!(record.record, id(0xFFFF_0000_0000_0007));
    assert_eq!(record.parent, id(42));
    assert_eq!(record.usn, 7);
    assert_eq!(record.timestamp_ft, -3);
    assert_eq!(record.reason, USN_REASON_RENAME_NEW_NAME);
    assert_eq!(record.name, b"docs");
    assert!(record.is_dir());
}

#[test]
fn v3_fixture_high_halves_are_a_zero_extension() {
    let bytes = record_bytes(&RecordFixture::file(id(1), id(2), "x").with_version(3));
    assert_eq!(&bytes[16..24], &[0u8; 8]);
    assert_eq!(&bytes[32..40], &[0u8; 8]);
}

#[test]
fn v3_nonzero_high_half_is_truncated_not_fatal() {
    let fixture = RecordFixture::file(id(0x0102), id(0x0304), "x").with_version(3);
    let mut bytes = record_bytes(&fixture);
    bytes[16..24].fill(0xFF);
    bytes[32..40].fill(0xFF);
    let mut buffer = 0u64.to_le_bytes().to_vec();
    buffer.extend_from_slice(&bytes);
    let walk = walk_enum_buffer(&buffer).unwrap();
    assert_eq!(walk.records[0].record, id(0x0102));
    assert_eq!(walk.records[0].parent, id(0x0304));
}

#[test]
fn alignment_padding_between_records_is_honored() {
    let first = RecordFixture::file(id(1), id(0), "a");
    let second = RecordFixture::file(id(2), id(0), "b");
    let buffer = build_enum_buffer(0, &[first, second]);
    let walk = walk_enum_buffer(&buffer).unwrap();
    assert_eq!(walk.records.len(), 2);
    assert_eq!(walk.records[0].name, b"a");
    assert_eq!(walk.records[1].name, b"b");
}

#[test]
fn unpadded_record_length_is_rounded_up_defensively() {
    let first = RecordFixture::file(id(1), id(0), "abc");
    let second = RecordFixture::file(id(2), id(0), "bcd");
    let mut buffer = build_enum_buffer(0, &[first, second]);
    // The first record really occupies 72 bytes, but claims 66. Rounding the
    // end up to 80 still lands on the second record at 8 + 72 = 80.
    buffer[8..12].copy_from_slice(&66u32.to_le_bytes());
    let walk = walk_enum_buffer(&buffer).unwrap();
    assert_eq!(walk.records.len(), 2);
    assert_eq!(walk.records[0].name, b"abc");
    assert_eq!(walk.records[1].name, b"bcd");
}

#[test]
fn file_name_length_is_bytes_not_chars() {
    let fixture = RecordFixture::file(id(1), id(0), "abc");
    let bytes = record_bytes(&fixture);
    assert_eq!(u16::from_le_bytes([bytes[56], bytes[57]]), 6);
    assert_eq!(u16::from_le_bytes([bytes[58], bytes[59]]), 60);
    assert_eq!(one(fixture).name, b"abc");
}

#[test]
fn padding_garbage_after_name_never_leaks() {
    let fixture = RecordFixture::file(id(1), id(0), "a");
    let bytes = record_bytes(&fixture);
    assert_eq!(bytes[62], PAD_BYTE);
    assert_eq!(bytes[63], PAD_BYTE);
    assert_eq!(one(fixture).name, b"a");
}

#[test]
fn max_component_name_of_255_units_parses() {
    let units: Vec<u16> = (0..255).map(|index| 0x4E00 + index as u16).collect();
    let fixture = RecordFixture::file(id(1), id(0), "").with_name_units(units.clone());
    let record = one(fixture);
    assert_eq!(wtf8::to_utf16(&record.name), units);
    assert!(!record.name_lossy);
}

#[test]
fn unpaired_surrogate_name_round_trips_via_wtf8() {
    let units = vec![0x0061, 0xD800, 0x0062];
    for version in [2, 3] {
        let fixture = RecordFixture::file(id(1), id(0), "")
            .with_version(version)
            .with_name_units(units.clone());
        let record = one(fixture);
        assert!(record.name_lossy);
        assert_eq!(wtf8::to_utf16(&record.name), units);
    }
}

#[test]
fn empty_name_is_accepted() {
    let record = one(RecordFixture::file(id(1), id(0), ""));
    assert!(record.name.is_empty());
    assert!(!record.name_lossy);
}

#[test]
fn v4_records_are_skipped_and_counted() {
    let mut buffer = 0u64.to_le_bytes().to_vec();
    buffer.extend_from_slice(&build_v4_record_bytes());
    buffer.extend_from_slice(&record_bytes(&RecordFixture::file(id(7), id(0), "kept")));
    let walk = walk_enum_buffer(&buffer).unwrap();
    assert_eq!(walk.skipped.v4, 1);
    assert_eq!(walk.skipped.unknown_version, 0);
    assert_eq!(walk.records.len(), 1);
    assert_eq!(walk.records[0].record, id(7));
}

#[test]
fn unknown_major_version_is_skipped_and_counted() {
    let fixture = RecordFixture::file(id(1), id(0), "x");
    let mut bytes = record_bytes(&fixture);
    bytes[4..6].copy_from_slice(&9u16.to_le_bytes());
    let mut buffer = 0u64.to_le_bytes().to_vec();
    buffer.extend_from_slice(&bytes);
    buffer.extend_from_slice(&record_bytes(&RecordFixture::file(id(2), id(0), "y")));
    let walk = walk_enum_buffer(&buffer).unwrap();
    assert_eq!(walk.skipped.unknown_version, 1);
    assert_eq!(walk.records.len(), 1);
    assert_eq!(walk.records[0].name, b"y");
}

#[test]
fn zero_record_length_is_an_error() {
    let mut buffer = 0u64.to_le_bytes().to_vec();
    buffer.extend_from_slice(&[0u8; 8]);
    assert_eq!(
        walk_enum_buffer(&buffer),
        Err(WalkError::ZeroRecordLength { offset: 8 })
    );
}

#[test]
fn record_overrun_is_an_error() {
    let buffer = with_patch(RecordFixture::file(id(1), id(0), "a"), |bytes| {
        bytes[0..4].copy_from_slice(&9999u32.to_le_bytes());
    });
    assert_eq!(
        walk_enum_buffer(&buffer),
        Err(WalkError::RecordOverrun { offset: 8 })
    );
}

#[test]
fn trailing_full_length_garbage_is_an_overrun() {
    let mut buffer = build_enum_buffer(0, &[RecordFixture::file(id(1), id(0), "a")]);
    // The first record occupies 64 bytes starting at offset 8, so the next
    // record would start at 72; a full eight-byte tail of 0xFF is read as a
    // 0xFFFFFFFF record length and must be reported as an overrun, not skipped.
    buffer.extend_from_slice(&[0xFF; 8]);
    assert_eq!(
        walk_enum_buffer(&buffer),
        Err(WalkError::RecordOverrun { offset: 72 })
    );
}

#[test]
fn truncated_v2_header_is_an_error() {
    let buffer = with_patch(RecordFixture::file(id(1), id(0), "a"), |bytes| {
        bytes[0..4].copy_from_slice(&16u32.to_le_bytes());
    });
    assert_eq!(
        walk_enum_buffer(&buffer),
        Err(WalkError::TruncatedHeader { offset: 8 })
    );
}

#[test]
fn truncated_v3_header_is_an_error() {
    let buffer = with_patch(
        RecordFixture::file(id(1), id(0), "a").with_version(3),
        |bytes| {
            bytes[0..4].copy_from_slice(&64u32.to_le_bytes());
        },
    );
    assert_eq!(
        walk_enum_buffer(&buffer),
        Err(WalkError::TruncatedHeader { offset: 8 })
    );
}

#[test]
fn name_span_outside_the_record_is_an_error() {
    let buffer = with_patch(RecordFixture::file(id(1), id(0), "a"), |bytes| {
        bytes[56..58].copy_from_slice(&512u16.to_le_bytes());
    });
    assert_eq!(
        walk_enum_buffer(&buffer),
        Err(WalkError::MalformedName { offset: 8 })
    );
}

#[test]
fn odd_name_length_is_an_error() {
    let buffer = with_patch(RecordFixture::file(id(1), id(0), "a"), |bytes| {
        bytes[56..58].copy_from_slice(&5u16.to_le_bytes());
    });
    assert_eq!(
        walk_enum_buffer(&buffer),
        Err(WalkError::MalformedName { offset: 8 })
    );
}

#[test]
fn name_offset_inside_the_fixed_header_is_an_error() {
    let buffer = with_patch(RecordFixture::file(id(1), id(0), "a"), |bytes| {
        bytes[58..60].copy_from_slice(&24u16.to_le_bytes());
    });
    assert_eq!(
        walk_enum_buffer(&buffer),
        Err(WalkError::MalformedName { offset: 8 })
    );
}

#[test]
fn leading_values_keep_their_signedness() {
    let enum_walk = walk_enum_buffer(&build_enum_buffer(u64::MAX, &[])).unwrap();
    assert_eq!(enum_walk.next_start, u64::MAX);
    let journal = walk_journal_buffer(&build_journal_buffer(-42, &[])).unwrap();
    assert_eq!(journal.next_usn, -42);
}

#[test]
fn an_eight_byte_buffer_yields_no_records() {
    let walk = walk_enum_buffer(&0u64.to_le_bytes()).unwrap();
    assert_eq!(walk.next_start, 0);
    assert!(walk.records.is_empty());
    assert_eq!(walk.skipped, SkipCounts::default());
}

#[test]
fn buffer_shorter_than_the_leading_value_is_an_error() {
    for buffer in [&b""[..], &[1, 2, 3][..]] {
        assert_eq!(
            walk_enum_buffer(buffer),
            Err(WalkError::TruncatedHeader { offset: 0 })
        );
        assert_eq!(
            walk_journal_buffer(buffer),
            Err(WalkError::TruncatedHeader { offset: 0 })
        );
    }
}

#[test]
fn sub_eight_byte_tail_after_the_last_record_is_a_normal_end() {
    let mut buffer = build_enum_buffer(0, &[RecordFixture::file(id(1), id(0), "a")]);
    buffer.extend_from_slice(&[0xFF; 4]);
    let walk = walk_enum_buffer(&buffer).unwrap();
    assert_eq!(walk.records.len(), 1);
}

#[test]
fn multi_record_buffer_walks_in_order_across_versions() {
    let fixtures = [
        RecordFixture::file(id(1), id(0), "one"),
        RecordFixture::dir(id(2), id(1), "two").with_version(3),
        RecordFixture::file(id(3), id(2), "three"),
    ];
    let walk = enum_records(&fixtures).unwrap();
    assert_eq!(
        walk.records.iter().map(|r| r.record).collect::<Vec<_>>(),
        vec![id(1), id(2), id(3)]
    );
    assert!(walk.records[1].is_dir());
    assert_eq!(walk.records[2].name, b"three");
}

#[test]
fn utf16_units_are_decoded_little_endian() {
    let units = vec![0x0102, 0x0103];
    let record = one(RecordFixture::file(id(1), id(0), "").with_name_units(units.clone()));
    let mut expected = Vec::new();
    wtf8::from_utf16(&units, &mut expected);
    assert_eq!(record.name, expected);
    assert_ne!(record.name, vec![0x02, 0x01, 0x03, 0x01]);
}

#[test]
fn v2_fixture_bytes_are_exact() {
    let bytes = record_bytes(
        &RecordFixture::file(id(0x0102_0304), id(5), "a")
            .with_usn(7)
            .with_timestamp(9)
            .with_reason(USN_REASON_FILE_CREATE)
            .with_attributes(0x20),
    );
    assert_eq!(bytes.len(), 64);
    assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 64);
    assert_eq!(u16::from_le_bytes(bytes[4..6].try_into().unwrap()), 2);
    assert_eq!(
        u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
        0x0102_0304
    );
    assert_eq!(u64::from_le_bytes(bytes[16..24].try_into().unwrap()), 5);
    assert_eq!(i64::from_le_bytes(bytes[24..32].try_into().unwrap()), 7);
    assert_eq!(i64::from_le_bytes(bytes[32..40].try_into().unwrap()), 9);
    assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 0x100);
    assert_eq!(u32::from_le_bytes(bytes[52..56].try_into().unwrap()), 0x20);
    assert_eq!(u16::from_le_bytes(bytes[56..58].try_into().unwrap()), 2);
    assert_eq!(u16::from_le_bytes(bytes[58..60].try_into().unwrap()), 60);
    assert_eq!(&bytes[60..62], &[b'a', 0]);
    assert_eq!(&bytes[62..64], &[PAD_BYTE, PAD_BYTE]);
}

#[test]
fn v3_fixture_bytes_are_exact() {
    let bytes = record_bytes(
        &RecordFixture::file(id(0x0102), id(0x0304), "ab")
            .with_version(3)
            .with_attributes(FILE_ATTRIBUTE_DIRECTORY),
    );
    assert_eq!(bytes.len(), 80);
    assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 80);
    assert_eq!(u16::from_le_bytes(bytes[4..6].try_into().unwrap()), 3);
    assert_eq!(u16::from_le_bytes(bytes[72..74].try_into().unwrap()), 4);
    assert_eq!(u16::from_le_bytes(bytes[74..76].try_into().unwrap()), 76);
    assert_eq!(u32::from_le_bytes(bytes[68..72].try_into().unwrap()), 0x10);
    assert_eq!(&bytes[76..80], &[b'a', 0, b'b', 0]);
}

#[test]
fn three_records_are_eight_byte_aligned_and_sized() {
    let first = record_bytes(&RecordFixture::file(id(1), id(0), "a"));
    let second = record_bytes(&RecordFixture::file(id(2), id(0), "ab").with_version(3));
    let third = record_bytes(&RecordFixture::file(id(3), id(0), "abc"));
    assert_eq!((first.len(), second.len(), third.len()), (64, 80, 72));
    let buffer = build_enum_buffer(
        0,
        &[
            RecordFixture::file(id(1), id(0), "a"),
            RecordFixture::file(id(2), id(0), "ab").with_version(3),
            RecordFixture::file(id(3), id(0), "abc"),
        ],
    );
    assert_eq!(buffer.len(), 8 + 64 + 80 + 72);
    assert_eq!(buffer.len() % 8, 0);
}

#[test]
fn fixture_rejects_versions_without_a_builder() {
    let result = std::panic::catch_unwind(|| {
        record_bytes(&RecordFixture::file(id(1), id(0), "x").with_version(4))
    });
    assert!(result.is_err());
}

#[test]
fn walk_error_codes_offsets_and_display_are_stable() {
    let errors = [
        (
            WalkError::ZeroRecordLength { offset: 8 },
            "INDEX_USN_RECORD_LENGTH_ZERO",
        ),
        (
            WalkError::RecordOverrun { offset: 8 },
            "INDEX_USN_RECORD_OVERRUN",
        ),
        (
            WalkError::TruncatedHeader { offset: 8 },
            "INDEX_USN_TRUNCATED_HEADER",
        ),
        (
            WalkError::MalformedName { offset: 8 },
            "INDEX_USN_MALFORMED_NAME",
        ),
    ];
    for (error, code) in errors {
        assert_eq!(error.code(), code);
        assert_eq!(error.offset(), 8);
        assert!(!error.to_string().is_empty());
        let _: &dyn std::error::Error = &error;
    }
}

proptest! {
    #[test]
    fn arbitrary_records_round_trip_both_versions(
        version in prop_oneof![Just(2u16), Just(3u16)],
        record in any::<u64>(),
        parent in any::<u64>(),
        usn in any::<i64>(),
        timestamp in any::<i64>(),
        reason in any::<u32>(),
        attributes in any::<u32>(),
        units in prop::collection::vec(any::<u16>(), 0..=255),
    ) {
        let fixture = RecordFixture::file(RecordId::new(record), RecordId::new(parent), "")
            .with_version(version)
            .with_usn(usn)
            .with_timestamp(timestamp)
            .with_reason(reason)
            .with_attributes(attributes)
            .with_name_units(units.clone());
        let walk = walk_enum_buffer(&build_enum_buffer(0, &[fixture])).unwrap();
        prop_assert_eq!(walk.records.len(), 1);
        let parsed = &walk.records[0];
        prop_assert_eq!(parsed.major_version, version);
        prop_assert_eq!(parsed.record, RecordId::new(record));
        prop_assert_eq!(parsed.parent, RecordId::new(parent));
        prop_assert_eq!(parsed.usn, usn);
        prop_assert_eq!(parsed.timestamp_ft, timestamp);
        prop_assert_eq!(parsed.reason, reason);
        prop_assert_eq!(parsed.attributes, attributes);
        prop_assert_eq!(wtf8::to_utf16(&parsed.name), units.clone());
        let mut expected = Vec::new();
        let lone = wtf8::from_utf16(&units, &mut expected);
        prop_assert_eq!(&parsed.name, &expected);
        prop_assert_eq!(parsed.name_lossy, lone);
    }

    #[test]
    fn journal_and_enum_walks_agree_on_the_same_records(
        units_a in prop::collection::vec(any::<u16>(), 0..=32),
        units_b in prop::collection::vec(any::<u16>(), 0..=32),
    ) {
        let fixtures = [
            RecordFixture::file(RecordId::new(1), RecordId::new(0), "").with_name_units(units_a),
            RecordFixture::file(RecordId::new(2), RecordId::new(1), "")
                .with_version(3)
                .with_name_units(units_b),
        ];
        let enum_walk = walk_enum_buffer(&build_enum_buffer(11, &fixtures)).unwrap();
        let journal = walk_journal_buffer(&build_journal_buffer(-7, &fixtures)).unwrap();
        prop_assert_eq!(enum_walk.records, journal.records);
        prop_assert_eq!(enum_walk.skipped, journal.skipped);
        prop_assert_eq!(enum_walk.next_start, 11);
        prop_assert_eq!(journal.next_usn, -7);
    }
}

#[test]
fn skipped_versions_still_require_a_complete_declared_common_header() {
    for major in [4u16, 99] {
        for length in 1u32..8 {
            let mut buffer = 99i64.to_le_bytes().to_vec();
            buffer.extend_from_slice(&length.to_le_bytes());
            buffer.extend_from_slice(&major.to_le_bytes());
            buffer.extend_from_slice(&0u16.to_le_bytes());
            assert_eq!(
                walk_enum_buffer(&buffer),
                Err(WalkError::TruncatedHeader { offset: 8 })
            );
            assert_eq!(
                walk_journal_buffer(&buffer),
                Err(WalkError::TruncatedHeader { offset: 8 })
            );
        }
    }
}
