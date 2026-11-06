use super::fixtures::{FileFixture, NameFixture, build_single, put_u32};
use super::wire::{FILE_FIRST_NAME_OFFSET, NAME_FILE_NAME_LENGTH_OFFSET, NAME_NEXT_NAME_OFFSET};
use super::*;
use crate::Error;
use crate::ids::RecordId;

fn reference(number: u64) -> RecordId {
    RecordId::new(number)
}

fn parent_a() -> RecordId {
    RecordId::new(5)
}

fn parent_b() -> RecordId {
    RecordId::new(8)
}

fn one_name(name: &str) -> FileFixture {
    FileFixture::file(reference(1), parent_a(), name)
}

#[test]
fn every_hard_link_name_is_kept_in_chain_order() {
    let file = one_name("long-name.txt").with_names(vec![
        NameFixture::primary(parent_a(), "long-name.txt"),
        NameFixture::primary(parent_b(), "second-link.txt"),
        NameFixture::dos_alias(parent_a(), "LONGNA~1.TXT"),
    ]);
    let page = build_single(&file);
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    let names = &parsed[0].names;
    assert_eq!(names.len(), 3);
    assert_eq!(names[0].name.as_slice(), b"long-name.txt");
    assert_eq!(names[1].name.as_slice(), b"second-link.txt");
    assert_eq!(names[2].name.as_slice(), b"LONGNA~1.TXT");
    assert_eq!(names[0].parent, parent_a());
    assert_eq!(names[1].parent, parent_b());
    assert_eq!(names[2].parent, parent_a());
    assert!(!names[0].dos_only);
    assert!(!names[1].dos_only);
    assert!(names[2].dos_only);
}

#[test]
fn a_primary_name_with_the_dos_bit_is_not_an_alias() {
    let name = NameFixture::primary(parent_a(), "README.TXT")
        .with_flags(FILE_LAYOUT_NAME_ENTRY_PRIMARY | FILE_LAYOUT_NAME_ENTRY_DOS);
    let page = build_single(&one_name("README.TXT").with_names(vec![name]));
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert!(!parsed[0].names[0].dos_only);
}

#[test]
fn unknown_name_flag_bits_are_ignored() {
    for (flags, dos_only) in [
        (0x0000_0008, false),
        (FILE_LAYOUT_NAME_ENTRY_DOS | 0x8, true),
        (FILE_LAYOUT_NAME_ENTRY_PRIMARY | 0x8, false),
    ] {
        let name = NameFixture::primary(parent_a(), "a").with_flags(flags);
        let page = build_single(&one_name("a").with_names(vec![name]));
        let parsed = walk_layout_buffer(&page.bytes).unwrap();
        assert_eq!(parsed[0].names[0].dos_only, dos_only, "{flags:#x}");
    }
}

#[test]
fn a_file_without_a_name_chain_has_no_names() {
    let fixture = one_name("a").with_names(Vec::new());
    let page = build_single(&fixture);
    let at = page.first_file() + FILE_FIRST_NAME_OFFSET;
    assert_eq!(&page.bytes[at..at + 4], &[0u8; 4]);
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert!(parsed[0].names.is_empty());
}

#[test]
fn a_name_above_the_component_limit_is_rejected_before_its_payload() {
    let page = build_single(&one_name("a"));
    let name = page.files[0].names[0];
    // Drop the payload entirely: a length-first check must still report the cap.
    let mut bytes = page.bytes[..name + NAME_ENTRY_HEADER_LEN].to_vec();
    put_u32(&mut bytes, name + NAME_FILE_NAME_LENGTH_OFFSET, 511);
    let error = walk_layout_buffer(&bytes).unwrap_err();
    assert_eq!(
        error,
        Error::NameTooLong {
            what: "FILE_LAYOUT_NAME_ENTRY.FileName",
            offset: name,
            len: 511,
            max: MAX_NAME_BYTES,
        }
    );
}

#[test]
fn the_component_limit_is_510_bytes() {
    let longest = NameFixture::primary_units(parent_a(), vec![0x0061; 255]);
    let page = build_single(&one_name("a").with_names(vec![longest]));
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    // `a` is one WTF-8 byte, so the 255-unit name is 510 UTF-16 bytes.
    assert_eq!(parsed[0].names[0].name.len(), 255);
    assert_eq!(crate::wtf8::to_utf16(&parsed[0].names[0].name).len(), 255);

    let mut bytes = page.bytes.clone();
    put_u32(
        &mut bytes,
        page.files[0].names[0] + NAME_FILE_NAME_LENGTH_OFFSET,
        512,
    );
    let error = walk_layout_buffer(&bytes).unwrap_err();
    assert_eq!(
        error,
        Error::NameTooLong {
            what: "FILE_LAYOUT_NAME_ENTRY.FileName",
            offset: page.files[0].names[0],
            len: 512,
            max: MAX_NAME_BYTES,
        }
    );
}

#[test]
fn an_odd_name_length_is_odd_utf16() {
    let page = build_single(&one_name("a"));
    let name = page.files[0].names[0];
    let mut bytes = page.bytes.clone();
    put_u32(&mut bytes, name + NAME_FILE_NAME_LENGTH_OFFSET, 3);
    let error = walk_layout_buffer(&bytes).unwrap_err();
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
fn name_length_is_a_byte_count_not_a_code_unit_count() {
    let fixture = one_name("a").with_names(vec![NameFixture::primary_units(
        parent_a(),
        vec![0x0061, 0x011F, 0x0061],
    )]);
    let page = build_single(&fixture);
    let name = page.files[0].names[0];
    let length_at = name + NAME_FILE_NAME_LENGTH_OFFSET;
    assert_eq!(&page.bytes[length_at..length_at + 4], &6u32.to_le_bytes());
    let mut bytes = page.bytes.clone();
    // Four bytes are two code units: the name is truncated, not rejected.
    put_u32(&mut bytes, name + NAME_FILE_NAME_LENGTH_OFFSET, 4);
    let parsed = walk_layout_buffer(&bytes).unwrap();
    assert_eq!(
        crate::wtf8::to_utf16(&parsed[0].names[0].name),
        vec![0x0061, 0x011F]
    );
}

#[test]
fn the_reserved_field_after_the_length_is_ignored() {
    let page = build_single(&one_name("name"));
    let name = page.files[0].names[0];
    let mut bytes = page.bytes.clone();
    for byte in &mut bytes[name + 20..name + NAME_ENTRY_HEADER_LEN] {
        *byte = 0xAA;
    }
    let parsed = walk_layout_buffer(&bytes).unwrap();
    assert_eq!(parsed[0].names[0].name.as_slice(), b"name");
}

#[test]
fn a_lone_surrogate_name_is_wtf8_and_flagged() {
    let units = vec![0x0061, 0xD800, 0x0062];
    let fixture =
        one_name("a").with_names(vec![NameFixture::primary_units(parent_a(), units.clone())]);
    let page = build_single(&fixture);
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    let name = &parsed[0].names[0];
    assert_eq!(name.name.as_slice(), b"a\xED\xA0\x80b");
    assert!(name.name_lossy);
    assert_eq!(crate::wtf8::to_utf16(&name.name), units);
}

#[test]
fn a_unicode_name_matches_its_utf8_spelling() {
    let text = "ağaç-🎉.pdf";
    let page = build_single(&one_name(text));
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed[0].names[0].name.as_slice(), text.as_bytes());
    assert!(!parsed[0].names[0].name_lossy);
}

#[test]
fn duplicate_names_are_kept() {
    let fixture = one_name("dup.txt").with_names(vec![
        NameFixture::primary(parent_a(), "dup.txt"),
        NameFixture::primary(parent_a(), "dup.txt"),
    ]);
    let page = build_single(&fixture);
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed[0].names.len(), 2);
    assert_eq!(parsed[0].names[0], parsed[0].names[1]);
}

#[test]
fn a_zero_length_name_is_empty() {
    let page = build_single(&one_name("a"));
    let name = page.files[0].names[0];
    let mut bytes = page.bytes[..name + NAME_ENTRY_HEADER_LEN].to_vec();
    put_u32(&mut bytes, name + NAME_FILE_NAME_LENGTH_OFFSET, 0);
    let parsed = walk_layout_buffer(&bytes).unwrap();
    assert!(parsed[0].names[0].name.is_empty());
    assert!(!parsed[0].names[0].name_lossy);
}

#[test]
fn a_name_entry_shorter_than_twenty_four_bytes_is_truncated() {
    let page = build_single(&one_name("a"));
    let name = page.files[0].names[0];
    let cut = name + 12;
    let error = walk_layout_buffer(&page.bytes[..cut]).unwrap_err();
    assert_eq!(
        error,
        Error::Truncated {
            what: "FILE_LAYOUT_NAME_ENTRY",
            offset: name,
            need: NAME_ENTRY_HEADER_LEN,
            len: 12,
        }
    );
}

#[test]
fn a_name_payload_running_past_the_page_is_truncated() {
    let fixture = one_name("a").with_names(vec![NameFixture::primary(parent_a(), "abcd")]);
    let page = build_single(&fixture);
    let name = page.files[0].names[0];
    let payload = name + NAME_ENTRY_HEADER_LEN;
    let mut bytes = page.bytes[..payload + 4].to_vec();
    put_u32(&mut bytes, name + NAME_FILE_NAME_LENGTH_OFFSET, 20);
    let error = walk_layout_buffer(&bytes).unwrap_err();
    assert_eq!(
        error,
        Error::Truncated {
            what: "FILE_LAYOUT_NAME_ENTRY.FileName",
            offset: payload,
            need: 20,
            len: 4,
        }
    );
}

#[test]
fn a_first_name_offset_inside_the_file_entry_is_a_cycle() {
    let mut page = build_single(&one_name("a"));
    let file = page.first_file();
    put_u32(&mut page.bytes, file + FILE_FIRST_NAME_OFFSET, 8);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert_eq!(
        error,
        Error::OffsetCycle {
            what: "FILE_LAYOUT_ENTRY.FirstNameOffset",
            offset: file,
            rel: 8,
            min: FILE_ENTRY_LEN,
        }
    );
}

#[test]
fn a_next_name_offset_that_does_not_advance_is_a_cycle() {
    let fixture = one_name("a").with_names(vec![
        NameFixture::primary(parent_a(), "a"),
        NameFixture::primary(parent_a(), "b"),
    ]);
    let mut page = build_single(&fixture);
    let first = page.files[0].names[0];
    put_u32(&mut page.bytes, first + NAME_NEXT_NAME_OFFSET, 4);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert_eq!(
        error,
        Error::OffsetCycle {
            what: "FILE_LAYOUT_NAME_ENTRY.NextNameOffset",
            offset: first,
            rel: 4,
            min: NAME_ENTRY_HEADER_LEN,
        }
    );
}

#[test]
fn a_next_name_offset_past_the_page_is_out_of_bounds() {
    let fixture = one_name("a").with_names(vec![
        NameFixture::primary(parent_a(), "a"),
        NameFixture::primary(parent_a(), "b"),
    ]);
    let mut page = build_single(&fixture);
    let first = page.files[0].names[0];
    put_u32(&mut page.bytes, first + NAME_NEXT_NAME_OFFSET, 60_000);
    let error = walk_layout_buffer(&page.bytes).unwrap_err();
    assert_eq!(
        error,
        Error::OffsetOutOfBounds {
            what: "FILE_LAYOUT_NAME_ENTRY.NextNameOffset",
            offset: first + 60_000,
            len: page.bytes.len(),
        }
    );
}

#[test]
fn names_are_packed_without_padding() {
    let fixture = one_name("a").with_names(vec![
        NameFixture::primary(parent_a(), "a"),
        NameFixture::primary(parent_a(), "bb"),
    ]);
    let page = build_single(&fixture);
    let offsets = &page.files[0].names;
    assert_eq!(offsets[1] - offsets[0], NAME_ENTRY_HEADER_LEN + 2);
}
