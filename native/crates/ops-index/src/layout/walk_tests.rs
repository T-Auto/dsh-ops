use super::fixtures::{
    FileFixture, InfoFixture, NameFixture, StreamFixture, build_page, build_shared_name_chain,
    build_shared_name_payload, build_shared_stream_chain, build_single, put_u32,
};
use super::wire::{
    FILE_EXTRA_INFO_OFFSET, FILE_NEXT_FILE_OFFSET, NAME_FILE_NAME_LENGTH_OFFSET,
    STREAM_IDENTIFIER_LENGTH_OFFSET,
};
use super::*;
use crate::Error;
use crate::ids::RecordId;
use proptest::prelude::*;

const PARENT: u64 = 5;
const SECOND_PARENT: u64 = 8;

fn reference(number: u64) -> RecordId {
    RecordId::new(number)
}

fn report() -> FileFixture {
    FileFixture::file(
        reference(0x0006_0000_0000_0001),
        reference(PARENT),
        "report.pdf",
    )
    .with_info(InfoFixture::legacy(133_000_000_000_000_000))
    .with_streams(vec![StreamFixture::unnamed(4096)])
}

fn notes() -> FileFixture {
    FileFixture::file(reference(2), reference(SECOND_PARENT), "notes.txt")
        .with_streams(vec![StreamFixture::unnamed_explicit(123)])
}

#[test]
fn an_empty_buffer_is_an_empty_page() {
    assert_eq!(walk_layout_buffer(&[]).unwrap(), Vec::new());
}

#[test]
fn a_zero_entry_count_is_an_empty_page_whatever_the_offsets_say() {
    let mut page = build_single(&report());
    put_u32(&mut page.bytes, 0, 0);
    put_u32(&mut page.bytes, 4, 60_000);
    put_u32(&mut page.bytes, 8, 0xFFFF_FFFF);
    put_u32(&mut page.bytes, 12, 0xFFFF_FFFF);
    assert_eq!(walk_layout_buffer(&page.bytes).unwrap(), Vec::new());
}

#[test]
fn a_header_shorter_than_sixteen_bytes_is_truncated() {
    let page = build_single(&report());
    for length in 1..OUTPUT_HEADER_LEN {
        let error = walk_layout_buffer(&page.bytes[..length]).unwrap_err();
        assert_eq!(
            error,
            Error::Truncated {
                what: "QUERY_FILE_LAYOUT_OUTPUT",
                offset: 0,
                need: OUTPUT_HEADER_LEN,
                len: length,
            },
            "{length}"
        );
    }
}

#[test]
fn a_three_file_chain_parses_in_offset_order() {
    let fixtures = vec![
        report(),
        FileFixture::dir(reference(3), reference(PARENT), "docs")
            .with_info(InfoFixture::rs5(-1))
            .with_streams(vec![StreamFixture::unnamed(0)]),
        notes(),
    ];
    let page = build_page(&fixtures);
    assert_eq!(page.first_file(), OUTPUT_HEADER_LEN);
    let expected: Vec<LayoutFile> = fixtures.iter().map(FileFixture::expected).collect();
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed, expected);
    assert!(!parsed[0].is_dir());
    assert!(parsed[1].is_dir());
    assert_eq!(parsed[1].size, None);
    assert_eq!(parsed[1].mtime_ft, Some(-1));
    assert_eq!(parsed[2].size, Some(123));
}

#[test]
fn a_first_file_offset_inside_the_header_is_a_cycle() {
    for rel in 0..OUTPUT_HEADER_LEN as u32 {
        let mut page = build_single(&report());
        put_u32(&mut page.bytes, 4, rel);
        let error = walk_layout_buffer(&page.bytes).unwrap_err();
        assert_eq!(
            error,
            Error::OffsetCycle {
                what: "QUERY_FILE_LAYOUT_OUTPUT.FirstFileOffset",
                offset: 0,
                rel,
                min: OUTPUT_HEADER_LEN,
            },
            "{rel}"
        );
    }
}

#[test]
fn a_first_file_offset_past_the_page_is_out_of_bounds() {
    let mut page = build_single(&report());
    put_u32(&mut page.bytes, 4, 60_000);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert_eq!(
        error,
        Error::OffsetOutOfBounds {
            what: "QUERY_FILE_LAYOUT_OUTPUT.FirstFileOffset",
            offset: 60_000,
            len: page.bytes.len(),
        }
    );
}

#[test]
fn a_next_file_offset_that_does_not_advance_is_a_cycle() {
    // A zero offset terminates the chain; a non-zero offset below 40 cannot advance.
    for rel in [8u32, 39] {
        let mut page = build_page(&[report(), notes()]);
        let first = page.first_file();
        put_u32(&mut page.bytes, first + FILE_NEXT_FILE_OFFSET, rel);
        let error = walk_layout_buffer(&page.bytes).unwrap_err();
        assert_eq!(
            error,
            Error::OffsetCycle {
                what: "FILE_LAYOUT_ENTRY.NextFileOffset",
                offset: first,
                rel,
                min: FILE_ENTRY_LEN,
            },
            "{rel}"
        );
    }
}

#[test]
fn a_next_file_offset_past_the_page_is_out_of_bounds() {
    let mut page = build_page(&[report(), notes()]);
    let first = page.first_file();
    put_u32(&mut page.bytes, first + FILE_NEXT_FILE_OFFSET, 60_000);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert_eq!(
        error,
        Error::OffsetOutOfBounds {
            what: "FILE_LAYOUT_ENTRY.NextFileOffset",
            offset: first + 60_000,
            len: page.bytes.len(),
        }
    );
}

#[test]
fn a_file_entry_shorter_than_forty_bytes_is_truncated() {
    let page = build_single(&report());
    let cut = OUTPUT_HEADER_LEN + 30;
    let error = walk_layout_buffer(&page.bytes[..cut]).unwrap_err();
    assert_eq!(
        error,
        Error::Truncated {
            what: "FILE_LAYOUT_ENTRY",
            offset: OUTPUT_HEADER_LEN,
            need: FILE_ENTRY_LEN,
            len: 30,
        }
    );
}

#[test]
fn the_entry_count_only_reserves_capacity() {
    let fixtures = vec![report(), notes()];
    let mut page = build_page(&fixtures);
    put_u32(&mut page.bytes, 0, 1);
    assert_eq!(walk_layout_buffer(&page.bytes).unwrap().len(), 2);
    let mut page = build_page(&fixtures);
    put_u32(&mut page.bytes, 0, 5);
    assert_eq!(walk_layout_buffer(&page.bytes).unwrap().len(), 2);
    let mut page = build_page(&fixtures);
    put_u32(&mut page.bytes, 0, u32::MAX);
    assert_eq!(walk_layout_buffer(&page.bytes).unwrap().len(), 2);
}

#[test]
fn a_zero_next_file_offset_terminates_the_chain() {
    let page = build_single(&report());
    let mut bytes = page.bytes.clone();
    bytes.extend_from_slice(&[0xAB; 64]);
    let parsed = walk_layout_buffer(&bytes).unwrap();
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0], report().expected());
}

#[test]
fn a_defect_in_a_later_file_discards_the_whole_page() {
    let mut page = build_page(&[report(), notes()]);
    let second = page.files[1].file;
    put_u32(&mut page.bytes, second + FILE_NEXT_FILE_OFFSET, 8);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert!(
        matches!(error, Error::OffsetCycle { .. }),
        "a page with a bad later entry must fail as a whole, got {error:?}"
    );

    let page = build_page(&[report(), notes()]);
    let second = page.files[1].file;
    let cut = second + 20;
    let error = walk_layout_buffer(&page.bytes[..cut]).unwrap_err();
    assert_eq!(
        error,
        Error::Truncated {
            what: "FILE_LAYOUT_ENTRY",
            offset: second,
            need: FILE_ENTRY_LEN,
            len: 20,
        }
    );
}

#[test]
fn name_errors_mask_info_and_stream_errors() {
    let fixture = FileFixture::file(reference(7), reference(PARENT), "x")
        .with_info(InfoFixture::legacy(1))
        .with_streams(vec![StreamFixture::unnamed(1)]);
    let mut page = build_single(&fixture);
    let file = page.first_file();
    let name = page.files[0].names[0];
    let stream = page.files[0].streams[0];
    put_u32(&mut page.bytes, name + NAME_FILE_NAME_LENGTH_OFFSET, 3);
    put_u32(&mut page.bytes, file + FILE_EXTRA_INFO_OFFSET, 50_000);
    put_u32(&mut page.bytes, stream + STREAM_IDENTIFIER_LENGTH_OFFSET, 3);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert_eq!(
        error,
        Error::OddUtf16Length {
            what: "FILE_LAYOUT_NAME_ENTRY.FileNameLength",
            offset: name,
            len: 3,
        }
    );
}

#[test]
fn info_errors_mask_stream_errors() {
    let fixture = FileFixture::file(reference(7), reference(PARENT), "x")
        .with_info(InfoFixture::legacy(1))
        .with_streams(vec![StreamFixture::unnamed(1)]);
    let mut page = build_single(&fixture);
    let file = page.first_file();
    let stream = page.files[0].streams[0];
    let last = page.bytes.len() - 1;
    put_u32(
        &mut page.bytes,
        file + FILE_EXTRA_INFO_OFFSET,
        (last - file) as u32,
    );
    put_u32(&mut page.bytes, stream + STREAM_IDENTIFIER_LENGTH_OFFSET, 3);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert_eq!(
        error,
        Error::Truncated {
            what: "FILE_LAYOUT_INFO_ENTRY",
            offset: last,
            need: INFO_PREFIX_LEN,
            len: 1,
        }
    );
}

#[test]
fn overlapping_records_are_tolerated_when_the_chain_advances() {
    let fixture = FileFixture::file(reference(7), reference(PARENT), "a").with_names(vec![
        NameFixture::primary(reference(PARENT), "a"),
        NameFixture::primary(reference(PARENT), "b"),
    ]);
    let mut page = build_single(&fixture);
    let first = page.files[0].names[0];
    let second = page.files[0].names[1];
    // The first name now claims 28 bytes, so its payload swallows the whole
    // second header and payload. The chain pointer still says "next is second".
    let length = (second + NAME_ENTRY_HEADER_LEN + 2 - (first + NAME_ENTRY_HEADER_LEN)) as u32;
    put_u32(
        &mut page.bytes,
        first + NAME_FILE_NAME_LENGTH_OFFSET,
        length,
    );
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed[0].names.len(), 2);
    assert_eq!(parsed[0].names[1].name, b"b");
    assert_eq!(
        crate::wtf8::to_utf16(&parsed[0].names[0].name).len(),
        (length / 2) as usize
    );
}

#[test]
fn a_page_parses_at_any_alignment() {
    let page = build_page(&[report(), notes()]);
    let expected = walk_layout_buffer(&page.bytes).unwrap();
    for shift in 1..=7 {
        let mut buffer = vec![0xAAu8; shift];
        buffer.extend_from_slice(&page.bytes);
        assert_eq!(walk_layout_buffer(&buffer[shift..]).unwrap(), expected);
    }
}

#[test]
fn unused_header_and_entry_fields_are_ignored() {
    let mut page = build_single(&report());
    let file = page.first_file();
    put_u32(&mut page.bytes, 8, 0xFFFF_FFFF);
    put_u32(&mut page.bytes, 12, 0xDEAD_BEEF);
    // Version and Flags inside FILE_LAYOUT_ENTRY carry nothing this parser uses.
    put_u32(&mut page.bytes, file, 0xFFFF_FFFF);
    put_u32(&mut page.bytes, file + 8, 0xFFFF_FFFF);
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed[0], report().expected());
}

#[test]
fn single_byte_mutations_never_panic() {
    let page = build_page(&[report(), notes()]);
    for index in 0..page.bytes.len() {
        for value in [0x00u8, 0x01, 0x7F, 0x80, 0xFF] {
            let mut bytes = page.bytes.clone();
            bytes[index] = value;
            let _ = walk_layout_buffer(&bytes);
        }
    }
}

#[test]
fn errors_name_the_field_and_the_offset() {
    let error = Error::OffsetCycle {
        what: "FILE_LAYOUT_ENTRY.NextFileOffset",
        offset: 16,
        rel: 8,
        min: FILE_ENTRY_LEN,
    };
    let text = error.to_string();
    assert!(text.contains("FILE_LAYOUT_ENTRY.NextFileOffset"), "{text}");
    assert!(text.contains("offset 16"), "{text}");
    assert!(text.contains("relative offset 8"), "{text}");
    assert!(text.contains("below 40"), "{text}");
}

fn arb_name_fixture() -> impl Strategy<Value = NameFixture> {
    (
        any::<u64>(),
        prop::collection::vec(any::<u16>(), 0..8),
        0u32..=3,
    )
        .prop_map(|(parent, units, flags)| {
            NameFixture::from_parts(RecordId::new(parent), units, flags)
        })
}

fn arb_stream_fixture() -> impl Strategy<Value = StreamFixture> {
    (
        prop::collection::vec(any::<u16>(), 0..6),
        any::<i64>(),
        any::<i64>(),
    )
        .prop_map(|(units, end_of_file, allocation_size)| {
            StreamFixture::from_parts(units, end_of_file, allocation_size)
        })
}

fn arb_file_fixture() -> impl Strategy<Value = FileFixture> {
    (
        any::<u64>(),
        prop::sample::select(vec![0u32, 0x20, FILE_ATTRIBUTE_DIRECTORY, 0x2020]),
        prop::collection::vec(arb_name_fixture(), 0..4),
        prop::option::of(any::<i64>()),
        prop::collection::vec(arb_stream_fixture(), 0..3),
    )
        .prop_map(
            |(reference, attributes, names, mtime, streams)| FileFixture {
                reference: RecordId::new(reference),
                attributes,
                names,
                info: mtime.map(InfoFixture::legacy),
                streams,
            },
        )
}

proptest! {
    #[test]
    fn arbitrary_bytes_are_ok_or_err_never_a_panic(bytes in prop::collection::vec(any::<u8>(), 0..256)) {
        if let Err(error) = walk_layout_buffer(&bytes) {
            prop_assert!(!error.code().is_empty());
        }
    }

    #[test]
    fn built_pages_parse_back_to_their_fixtures(fixtures in prop::collection::vec(arb_file_fixture(), 0..6)) {
        let page = build_page(&fixtures);
        let parsed = walk_layout_buffer(&page.bytes).unwrap();
        let expected: Vec<LayoutFile> = fixtures.iter().map(FileFixture::expected).collect();
        prop_assert_eq!(parsed, expected);
    }
}

#[test]
fn many_files_sharing_one_name_chain_are_rejected() {
    // The reviewer's shape: 128 file entries all reach the same 128-entry chain.
    // The page is only a few KiB, but decoding it would make 16384 structure
    // steps. Empty names keep the payload budget out of the way so this pins the
    // step budget itself.
    let page = build_shared_name_payload(128, 128, 0);
    assert!(page.bytes.len() < 16 * 1024);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert_eq!(error.code(), "INDEX_LAYOUT_PAGE_BUDGET");
    assert!(matches!(
        error,
        Error::PageBudgetExceeded {
            what: "FILE_LAYOUT_NAME_ENTRY",
            limit,
        } if limit == page.bytes.len()
    ));
}

#[test]
fn many_files_sharing_one_stream_chain_are_rejected() {
    let page = build_shared_stream_chain(128, 128);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert!(matches!(
        error,
        Error::PageBudgetExceeded {
            what: "STREAM_LAYOUT_ENTRY",
            limit,
        } if limit == page.bytes.len()
    ));
}

#[test]
fn shared_name_payload_is_bounded_by_the_page() {
    // Two files sharing a chain of long names stay inside the step budget but
    // would decode twice as many payload bytes as the page stores.
    let page = build_shared_name_payload(2, 200, 100);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert_eq!(error.code(), "INDEX_LAYOUT_PAYLOAD_BUDGET");
    assert!(matches!(
        error,
        Error::PayloadBudgetExceeded {
            what: "FILE_LAYOUT_NAME_ENTRY.FileName",
            limit,
        } if limit == page.bytes.len()
    ));
}

#[test]
fn a_small_shared_name_chain_still_decodes() {
    // Sharing is not itself an error: two files reaching one two-name chain
    // fit the page-wide allowance and must decode identically.
    let page = build_shared_name_chain(2, 2);
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].names.len(), 2);
    assert_eq!(parsed[0].names, parsed[1].names);
}
