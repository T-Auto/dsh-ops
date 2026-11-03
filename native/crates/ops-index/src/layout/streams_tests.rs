use super::fixtures::{FileFixture, InfoFixture, StreamFixture, build_single, put_u32};
use super::wire::{
    FILE_EXTRA_INFO_LENGTH_OFFSET, FILE_EXTRA_INFO_OFFSET, FILE_FIRST_STREAM_OFFSET,
    STREAM_IDENTIFIER_LENGTH_OFFSET, STREAM_NEXT_STREAM_OFFSET,
};
use super::*;
use crate::Error;
use crate::ids::RecordId;

fn reference(number: u64) -> RecordId {
    RecordId::new(number)
}

fn parent() -> RecordId {
    RecordId::new(5)
}

fn file() -> FileFixture {
    FileFixture::file(reference(1), parent(), "data.bin")
}

#[test]
fn a_file_without_info_or_streams_reports_nothing() {
    let page = build_single(&file());
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed[0].mtime_ft, None);
    assert_eq!(parsed[0].size, None);
}

#[test]
fn a_legacy_info_entry_reports_the_modification_time() {
    let page = build_single(&file().with_info(InfoFixture::legacy(133_000_000_000_000_000)));
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed[0].mtime_ft, Some(133_000_000_000_000_000));
}

#[test]
fn a_declared_info_length_at_the_prefix_reports_the_time() {
    for declared in [INFO_PREFIX_LEN as u32, 32, INFO_ENTRY_LEGACY_LEN as u32] {
        let page =
            build_single(&file().with_info(InfoFixture::legacy(7).with_declared_length(declared)));
        let parsed = walk_layout_buffer(&page.bytes).unwrap();
        assert_eq!(parsed[0].mtime_ft, Some(7), "{declared}");
    }
}

#[test]
fn a_declared_info_length_below_the_prefix_reports_nothing() {
    for declared in 1..INFO_PREFIX_LEN as u32 {
        let page =
            build_single(&file().with_info(InfoFixture::legacy(7).with_declared_length(declared)));
        let parsed = walk_layout_buffer(&page.bytes).unwrap();
        assert_eq!(parsed[0].mtime_ft, None, "{declared}");
    }
}

#[test]
fn a_short_declared_length_does_not_read_the_offset() {
    let mut page = build_single(&file().with_info(InfoFixture::legacy(7)));
    let file_offset = page.first_file();
    let last = page.bytes.len() - 1;
    put_u32(
        &mut page.bytes,
        file_offset + FILE_EXTRA_INFO_OFFSET,
        (last - file_offset) as u32,
    );
    put_u32(
        &mut page.bytes,
        file_offset + FILE_EXTRA_INFO_LENGTH_OFFSET,
        16,
    );
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed[0].mtime_ft, None);
}

#[test]
fn a_truncated_info_prefix_is_reported() {
    let mut page = build_single(&file().with_info(InfoFixture::legacy(7)));
    let file_offset = page.first_file();
    let target = page.bytes.len() - 4;
    put_u32(
        &mut page.bytes,
        file_offset + FILE_EXTRA_INFO_OFFSET,
        (target - file_offset) as u32,
    );
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert_eq!(
        error,
        Error::Truncated {
            what: "FILE_LAYOUT_INFO_ENTRY",
            offset: target,
            need: INFO_PREFIX_LEN,
            len: 4,
        }
    );
}

#[test]
fn an_info_offset_inside_the_file_entry_is_a_cycle() {
    let mut page = build_single(&file().with_info(InfoFixture::legacy(7)));
    let file_offset = page.first_file();
    put_u32(&mut page.bytes, file_offset + FILE_EXTRA_INFO_OFFSET, 8);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert_eq!(
        error,
        Error::OffsetCycle {
            what: "FILE_LAYOUT_ENTRY.ExtraInfoOffset",
            offset: file_offset,
            rel: 8,
            min: FILE_ENTRY_LEN,
        }
    );
}

#[test]
fn the_size_comes_from_the_unnamed_data_stream() {
    let page = build_single(&file().with_streams(vec![StreamFixture::unnamed(4096)]));
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed[0].size, Some(4096));
}

#[test]
fn the_explicit_dollar_data_spelling_is_the_unnamed_stream() {
    let page = build_single(&file().with_streams(vec![StreamFixture::unnamed_explicit(123)]));
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed[0].size, Some(123));
}

#[test]
fn a_named_stream_reports_no_size() {
    let page = build_single(
        &file().with_streams(vec![StreamFixture::named(":Zone.Identifier:$DATA", 42)]),
    );
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed[0].size, None);
}

#[test]
fn a_negative_end_of_file_clamps_to_zero() {
    let page = build_single(&file().with_streams(vec![StreamFixture::unnamed(-5)]));
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed[0].size, Some(0));
}

#[test]
fn a_directory_reports_no_size_but_keeps_its_names() {
    let fixture = FileFixture::dir(reference(2), parent(), "docs")
        .with_info(InfoFixture::rs5(9))
        .with_streams(vec![StreamFixture::unnamed(4096)]);
    let page = build_single(&fixture);
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed[0].size, None);
    assert_eq!(parsed[0].mtime_ft, Some(9));
    assert_eq!(parsed[0].names.len(), 1);
    assert_eq!(parsed[0].names[0].name.as_slice(), b"docs");
}

#[test]
fn the_first_unnamed_stream_wins() {
    let page = build_single(&file().with_streams(vec![
        StreamFixture::named(":metadata", 5),
        StreamFixture::unnamed(100),
        StreamFixture::unnamed_explicit(200),
    ]));
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed[0].size, Some(100));
}

#[test]
fn only_the_exact_dollar_data_spelling_is_unnamed() {
    for spelling in [
        "::$data",
        ":$$DATA",
        "::$DATA ",
        "::$DATA\u{0}",
        "$DATA",
        ":unnamed",
        "::$DAT",
    ] {
        let units: Vec<u16> = spelling.encode_utf16().collect();
        let stream = StreamFixture::from_parts(units, 42, 0);
        let page = build_single(&file().with_streams(vec![stream]));
        let parsed = walk_layout_buffer(&page.bytes).unwrap();
        assert_eq!(parsed[0].size, None, "{spelling:?}");
    }
}

#[test]
fn allocation_size_is_not_the_size() {
    let page = build_single(
        &file().with_streams(vec![StreamFixture::unnamed(7).with_allocation_size(4096)]),
    );
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed[0].size, Some(7));
}

#[test]
fn an_odd_stream_identifier_length_is_odd_utf16() {
    let mut page = build_single(&file().with_streams(vec![StreamFixture::unnamed(1)]));
    let stream = page.files[0].streams[0];
    put_u32(&mut page.bytes, stream + STREAM_IDENTIFIER_LENGTH_OFFSET, 3);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert_eq!(
        error,
        Error::OddUtf16Length {
            what: "STREAM_LAYOUT_ENTRY.StreamIdentifierLength",
            offset: stream,
            len: 3,
        }
    );
}

#[test]
fn stream_identifiers_have_no_component_limit() {
    let long_name = "x".repeat(300);
    let page = build_single(&file().with_streams(vec![
        StreamFixture::named(&long_name, 1),
        StreamFixture::unnamed(9),
    ]));
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed[0].size, Some(9));
}

#[test]
fn a_stream_entry_shorter_than_forty_eight_bytes_is_truncated() {
    let page = build_single(&file().with_streams(vec![StreamFixture::unnamed(1)]));
    let stream = page.files[0].streams[0];
    let cut = stream + 30;
    let error = walk_layout_buffer(&page.bytes[..cut]).unwrap_err();
    assert_eq!(
        error,
        Error::Truncated {
            what: "STREAM_LAYOUT_ENTRY",
            offset: stream,
            need: STREAM_ENTRY_LEN,
            len: 30,
        }
    );
}

#[test]
fn a_stream_identifier_running_past_the_page_is_truncated() {
    let page =
        build_single(&file().with_streams(vec![StreamFixture::named(":Zone.Identifier", 1)]));
    let stream = page.files[0].streams[0];
    let payload = stream + STREAM_ENTRY_LEN;
    let mut bytes = page.bytes[..payload + 2].to_vec();
    put_u32(&mut bytes, stream + STREAM_IDENTIFIER_LENGTH_OFFSET, 20);
    let error = walk_layout_buffer(&bytes).unwrap_err();
    assert_eq!(
        error,
        Error::Truncated {
            what: "STREAM_LAYOUT_ENTRY.StreamIdentifier",
            offset: payload,
            need: 20,
            len: 2,
        }
    );
}

#[test]
fn a_first_stream_offset_inside_the_file_entry_is_a_cycle() {
    let mut page = build_single(&file().with_streams(vec![StreamFixture::unnamed(1)]));
    let file_offset = page.first_file();
    put_u32(&mut page.bytes, file_offset + FILE_FIRST_STREAM_OFFSET, 8);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert_eq!(
        error,
        Error::OffsetCycle {
            what: "FILE_LAYOUT_ENTRY.FirstStreamOffset",
            offset: file_offset,
            rel: 8,
            min: FILE_ENTRY_LEN,
        }
    );
}

#[test]
fn a_next_stream_offset_that_does_not_advance_is_a_cycle() {
    let mut page = build_single(&file().with_streams(vec![
        StreamFixture::unnamed(1),
        StreamFixture::named(":other", 2),
    ]));
    let first = page.files[0].streams[0];
    put_u32(&mut page.bytes, first + STREAM_NEXT_STREAM_OFFSET, 24);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert_eq!(
        error,
        Error::OffsetCycle {
            what: "STREAM_LAYOUT_ENTRY.NextStreamOffset",
            offset: first,
            rel: 24,
            min: STREAM_ENTRY_LEN,
        }
    );
}

#[test]
fn a_next_stream_offset_past_the_page_is_out_of_bounds() {
    let mut page = build_single(&file().with_streams(vec![
        StreamFixture::unnamed(1),
        StreamFixture::named(":other", 2),
    ]));
    let first = page.files[0].streams[0];
    put_u32(&mut page.bytes, first + STREAM_NEXT_STREAM_OFFSET, 60_000);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert_eq!(
        error,
        Error::OffsetOutOfBounds {
            what: "STREAM_LAYOUT_ENTRY.NextStreamOffset",
            offset: first + 60_000,
            len: page.bytes.len(),
        }
    );
}

#[test]
fn a_directory_still_reports_defects_in_its_stream_chain() {
    let mut page = build_single(
        &FileFixture::dir(reference(2), parent(), "docs")
            .with_streams(vec![StreamFixture::unnamed(4096)]),
    );
    let stream = page.files[0].streams[0];
    put_u32(&mut page.bytes, stream + STREAM_IDENTIFIER_LENGTH_OFFSET, 3);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert_eq!(
        error,
        Error::OddUtf16Length {
            what: "STREAM_LAYOUT_ENTRY.StreamIdentifierLength",
            offset: stream,
            len: 3,
        }
    );
}

#[test]
fn mtime_and_size_are_independent() {
    let page = build_single(&file().with_info(InfoFixture::legacy(11)));
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed[0].mtime_ft, Some(11));
    assert_eq!(parsed[0].size, None);
}
