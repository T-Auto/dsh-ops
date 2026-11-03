use super::fixtures::put_u32;
use super::streams::UNNAMED_DATA_IDENTIFIER_UTF16LE;
use super::wire::{self, FileEntry, NameEntry, OutputHeader, StreamEntry};
use super::*;
use crate::Error;

#[test]
fn wire_sizes_match_the_ntfs_contract() {
    assert_eq!(OUTPUT_HEADER_LEN, 16);
    assert_eq!(FILE_ENTRY_LEN, 40);
    assert_eq!(NAME_ENTRY_HEADER_LEN, 24);
    assert_eq!(INFO_PREFIX_LEN, 24);
    assert_eq!(STREAM_ENTRY_LEN, 48);
    assert_eq!(INFO_ENTRY_LEGACY_LEN, 56);
    assert_eq!(MAX_NAME_BYTES, 510);
}

#[test]
fn the_header_is_read_from_the_documented_positions() {
    let mut header = [0u8; OUTPUT_HEADER_LEN];
    put_u32(&mut header, 0, 7);
    put_u32(&mut header, 4, OUTPUT_HEADER_LEN as u32);
    // Flags and Reserved carry layout hints this parser never reads.
    put_u32(&mut header, 8, 0xFFFF_FFFF);
    put_u32(&mut header, 12, 0xDEAD_BEEF);
    let parsed = OutputHeader::parse(&header).unwrap();
    assert_eq!(parsed.entry_count, 7);
    assert_eq!(parsed.first_file_offset, OUTPUT_HEADER_LEN as u32);
}

#[test]
fn the_file_entry_is_read_from_the_documented_positions() {
    let mut raw = [0u8; FILE_ENTRY_LEN];
    // Version, Flags and the pre-RS5/RS5 union reserved bytes stay garbage.
    raw[0..4].fill(0xAA);
    put_u32(&mut raw, 4, 40);
    raw[8..12].fill(0xAA);
    put_u32(&mut raw, 12, 0x20);
    raw[16..24].copy_from_slice(&0x1234_0000_0000_0009u64.to_le_bytes());
    put_u32(&mut raw, 24, 24);
    put_u32(&mut raw, 28, 64);
    put_u32(&mut raw, 32, 80);
    put_u32(&mut raw, 36, 0);
    let parsed = FileEntry::parse(&raw, 0).unwrap();
    assert_eq!(parsed.next_file_offset, 40);
    assert_eq!(parsed.attributes, 0x20);
    assert_eq!(parsed.file_reference, 0x1234_0000_0000_0009);
    assert_eq!(parsed.first_name_offset, 24);
    assert_eq!(parsed.first_stream_offset, 64);
    assert_eq!(parsed.extra_info_offset, 80);
    assert_eq!(parsed.extra_info_length, 0);
}

#[test]
fn the_name_entry_is_read_from_the_documented_positions() {
    let mut raw = [0u8; NAME_ENTRY_HEADER_LEN];
    put_u32(&mut raw, 0, 24);
    put_u32(&mut raw, 4, FILE_LAYOUT_NAME_ENTRY_PRIMARY);
    raw[8..16].copy_from_slice(&0x0005_0000_0000_0002u64.to_le_bytes());
    put_u32(&mut raw, 16, 26);
    // Reserved follows the length and must not be interpreted.
    raw[20..24].fill(0xAA);
    let parsed = NameEntry::parse(&raw, 0).unwrap();
    assert_eq!(parsed.next_name_offset, 24);
    assert_eq!(parsed.flags, FILE_LAYOUT_NAME_ENTRY_PRIMARY);
    assert_eq!(parsed.parent_reference, 0x0005_0000_0000_0002);
    assert_eq!(parsed.name_length, 26);
}

#[test]
fn the_stream_entry_is_read_from_the_documented_positions() {
    let mut raw = [0u8; STREAM_ENTRY_LEN];
    raw[0..4].fill(0xAA);
    put_u32(&mut raw, 4, 48);
    raw[8..16].fill(0xAA);
    raw[16..24].copy_from_slice(&4096i64.to_le_bytes());
    raw[24..32].copy_from_slice(&123i64.to_le_bytes());
    raw[32..44].fill(0xAA);
    put_u32(&mut raw, 44, 14);
    let parsed = StreamEntry::parse(&raw, 0).unwrap();
    assert_eq!(parsed.next_stream_offset, 48);
    assert_eq!(parsed.end_of_file, 123);
    assert_eq!(parsed.identifier_length, 14);
}

#[test]
fn the_last_write_time_is_the_third_timestamp() {
    let mut raw = [0u8; INFO_PREFIX_LEN];
    raw[0..8].fill(0xAA);
    raw[8..16].fill(0xAA);
    raw[16..24].copy_from_slice(&133_000_000_000_000_000i64.to_le_bytes());
    assert_eq!(
        wire::last_write_time(&raw, 0).unwrap(),
        133_000_000_000_000_000
    );
}

#[test]
fn a_zero_length_read_never_looks_at_the_offset() {
    let page = [0u8; 4];
    assert_eq!(wire::read_bytes(&page, 0, 0, "ZERO").unwrap(), &[]);
    assert_eq!(wire::read_bytes(&page, 4, 0, "ZERO").unwrap(), &[]);
    assert_eq!(wire::read_bytes(&page, 999, 0, "ZERO").unwrap(), &[]);
}

#[test]
fn a_read_at_the_end_of_the_page_is_out_of_bounds() {
    let page = [0u8; 8];
    let error = wire::read_bytes(&page, 8, 1, "AT_END").unwrap_err();
    assert_eq!(
        error,
        Error::OffsetOutOfBounds {
            what: "AT_END",
            offset: 8,
            len: 8
        }
    );
}

#[test]
fn a_read_that_starts_inside_reports_the_bytes_left() {
    let page = [0u8; 10];
    let error = wire::read_bytes(&page, 6, 8, "CUT").unwrap_err();
    assert_eq!(
        error,
        Error::Truncated {
            what: "CUT",
            offset: 6,
            need: 8,
            len: 4
        }
    );
}

#[test]
fn an_offset_below_the_containing_structure_is_a_cycle() {
    let page = [0u8; 64];
    let error = wire::follow_offset(&page, 16, 8, 40, "NEXT").unwrap_err();
    assert_eq!(
        error,
        Error::OffsetCycle {
            what: "NEXT",
            offset: 16,
            rel: 8,
            min: 40
        }
    );
}

#[test]
fn an_offset_that_lands_on_the_end_is_out_of_bounds() {
    let page = [0u8; 64];
    let error = wire::follow_offset(&page, 16, 48, 40, "NEXT").unwrap_err();
    assert_eq!(
        error,
        Error::OffsetOutOfBounds {
            what: "NEXT",
            offset: 64,
            len: 64
        }
    );
}

#[test]
fn an_offset_addition_that_overflows_is_out_of_bounds() {
    let page = [0u8; 64];
    let error = wire::follow_offset(&page, usize::MAX - 3, 40, 40, "NEXT").unwrap_err();
    assert_eq!(
        error,
        Error::OffsetOutOfBounds {
            what: "NEXT",
            offset: usize::MAX,
            len: 64
        }
    );
}

#[test]
fn recommended_flags_request_names_streams_and_info() {
    assert_eq!(RECOMMENDED_LAYOUT_FLAGS, 0x36);
    assert_eq!(RECOMMENDED_LAYOUT_FLAGS & QUERY_FILE_LAYOUT_RESTART, 0);
    for flag in [
        QUERY_FILE_LAYOUT_INCLUDE_NAMES,
        QUERY_FILE_LAYOUT_INCLUDE_STREAMS,
        QUERY_FILE_LAYOUT_INCLUDE_EXTRA_INFO,
        QUERY_FILE_LAYOUT_INCLUDE_STREAMS_WITH_NO_CLUSTERS_ALLOCATED,
    ] {
        assert_ne!(RECOMMENDED_LAYOUT_FLAGS & flag, 0, "{flag:#x}");
    }
    assert_eq!(QUERY_FILE_LAYOUT_SINGLE_INSTANCED, 0x1);
    assert_eq!(FILE_LAYOUT_NAME_ENTRY_PRIMARY, 0x1);
    assert_eq!(FILE_LAYOUT_NAME_ENTRY_DOS, 0x2);
    assert_eq!(FILE_ATTRIBUTE_DIRECTORY, 0x10);
}

#[test]
fn the_unnamed_data_identifier_is_the_utf16le_spelling_of_dollar_data() {
    assert_eq!(UNNAMED_DATA_IDENTIFIER_UTF16LE.len(), 14);
    let expected: Vec<u8> = "::$DATA"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    assert_eq!(UNNAMED_DATA_IDENTIFIER_UTF16LE.to_vec(), expected);
    assert_eq!(&expected[..4], &[0x3A, 0x00, 0x3A, 0x00]);
}
