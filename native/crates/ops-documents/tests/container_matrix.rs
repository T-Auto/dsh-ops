//! Classic cross-reference tables, indirect integers and structural limits.
mod common;

use common::{
    CATALOG, HELVETICA, PAGES, Pdf, classic, read, stream, stream_with_length, text,
};
use ops_documents::pdf_container::{MAX_FILE, MAX_STREAM, parse};
use serde_json::json;

const CONTENT: &[u8] = b"BT /F1 12 Tf (Hello) Tj ET";

fn hello_objects() -> Vec<Vec<u8>> {
    vec![
        CATALOG.to_vec(),
        PAGES.to_vec(),
        b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
            .to_vec(),
        stream("", CONTENT),
        HELVETICA.to_vec(),
    ]
}

fn read_text(bytes: &[u8], expected: &str) {
    let output = read(bytes, json!({})).expect("read_pdf returns an observation");
    assert_eq!(output["status"], "completed", "{output}");
    assert_eq!(text(&output), expected, "{output}");
}

#[test]
fn indirect_integers_resolve_in_every_direction() {
    let mut direct = Pdf::new();
    direct.object(CATALOG);
    direct.object(PAGES);
    direct.object(
        b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    );
    direct.object(&stream("", CONTENT));
    direct.object(HELVETICA);

    let mut forward = Pdf::new();
    forward.object(CATALOG);
    forward.object(PAGES);
    forward.object(
        b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    );
    forward.object(&stream_with_length("6 0 R", "", CONTENT));
    forward.object(HELVETICA);
    forward.object(CONTENT.len().to_string().as_bytes());

    let mut backward = Pdf::new();
    backward.object(CATALOG);
    backward.object(PAGES);
    backward.object(
        b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 6 0 R >> >> /Contents 5 0 R >>",
    );
    backward.object(CONTENT.len().to_string().as_bytes());
    backward.object(&stream_with_length("4 0 R", "", CONTENT));
    backward.object(HELVETICA);

    for (case, mut pdf) in [
        ("direct", direct),
        ("forward", forward),
        ("backward", backward),
    ] {
        let size = pdf.offsets.len() + 1;
        pdf.classic_section(pdf.offsets.len(), size, "/Root 1 0 R");
        let bytes = pdf.bytes;
        let document = parse(&bytes).unwrap_or_else(|error| panic!("{case}: {}", error.message));
        assert_eq!(document.objects.len(), size - 1, "{case}");
        let content = if case == "backward" { 5 } else { 4 };
        assert_eq!(
            document.object((content, 0)).expect("content object").stream,
            Some(CONTENT),
            "{case}"
        );
        read_text(&bytes, "Hello");
    }

    let mut size = Pdf::new();
    for body in hello_objects() {
        size.object(&body);
    }
    size.object(b"7");
    let objects = size.offsets.len();
    let xref = size.bytes.len();
    size.bytes
        .extend_from_slice(format!("xref
0 {}
0000000000 65535 f 
", objects + 1).as_bytes());
    for number in 1..=objects {
        let offset = size.offsets[&number];
        size.bytes
            .extend_from_slice(format!("{offset:010} 00000 n 
").as_bytes());
    }
    size.bytes.extend_from_slice(
        format!("trailer
<< /Size 6 0 R /Root 1 0 R >>
startxref
{xref}
%%EOF
").as_bytes(),
    );
    read_text(&size.bytes, "Hello");
}

#[test]
fn dangling_and_cyclic_indirect_integers_are_reference_errors() {
    let mut length = Pdf::new();
    for body in hello_objects() {
        length.object(&body);
    }
    length.numbered(4, &stream_with_length("9 0 R", "", CONTENT));
    length.classic_section(5, 6, "/Root 1 0 R");

    let mut count = Pdf::new();
    count.object(CATALOG);
    count.object(b"<< /Type /Pages /Kids [3 0 R] /Count 9 0 R >>");
    count.object(b"<< /Type /Page /Parent 2 0 R >>");
    count.classic_section(3, 4, "/Root 1 0 R");

    let mut size = Pdf::new();
    for body in hello_objects() {
        size.object(&body);
    }
    let objects = size.offsets.len();
    let xref = size.bytes.len();
    size.bytes
        .extend_from_slice(format!("xref
0 {}
0000000000 65535 f 
", objects + 1).as_bytes());
    for number in 1..=objects {
        let offset = size.offsets[&number];
        size.bytes
            .extend_from_slice(format!("{offset:010} 00000 n 
").as_bytes());
    }
    size.bytes.extend_from_slice(
        format!("trailer
<< /Size 9 0 R /Root 1 0 R >>
startxref
{xref}
%%EOF
").as_bytes(),
    );

    let chain = |five: &[u8]| {
        let mut pdf = Pdf::new();
        pdf.object(CATALOG);
        pdf.object(PAGES);
        pdf.object(
            b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>",
        );
        pdf.object(&stream_with_length("5 0 R", "", CONTENT));
        pdf.object(five);
        pdf.object(HELVETICA);
        pdf.classic_section(6, 7, "/Root 1 0 R");
        pdf.bytes
    };

    let mut cyclic_count = Pdf::new();
    cyclic_count.object(CATALOG);
    cyclic_count.object(b"<< /Type /Pages /Kids [3 0 R] /Count 4 0 R >>");
    cyclic_count.object(b"<< /Type /Page /Parent 2 0 R >>");
    cyclic_count.object(b"4 0 R");
    cyclic_count.classic_section(4, 5, "/Root 1 0 R");

    for (case, bytes, needle) in [
        ("dangling /Length", length.bytes, "does not name an active"),
        ("dangling /Count", count.bytes, "does not name an active"),
        ("dangling /Size", size.bytes, "does not name an active"),
        ("cyclic /Length", chain(b"5 0 R"), "Cyclic PDF reference"),
        ("cyclic /Count", cyclic_count.bytes, "Cyclic PDF reference"),
        (
            "non-integer /Length",
            chain(b"(not a number)"),
            "must reference a direct integer",
        ),
    ] {
        let error = read(&bytes, json!({})).expect_err("the reference must fail the read");
        assert_eq!(error.code, "DOCUMENT_PARSE_ERROR", "{case}: {}", error.message);
        assert!(error.message.contains(needle), "{case}: {}", error.message);
        assert!(!error.message.contains("bounded nonnegative"), "{case}: {}", error.message);
    }
}

#[test]
fn input_and_structure_limits_are_refused_at_one_over() {
    let oversized = vec![b' '; MAX_FILE + 1];
    let error = read(&oversized, json!({})).expect_err("a file over 16 MiB must fail");
    assert_eq!(error.code, "OUTPUT_LIMIT");
    assert!(error.next_action.contains("16 MiB"), "{}", error.next_action);

    let bodies: Vec<Vec<u8>> = vec![
        format!("<< /Length {} >>\nstream\nx\nendstream", MAX_STREAM + 1).into_bytes(),
    ];
    for (index, body) in bodies.iter().enumerate() {
        let error = parse(&classic(std::slice::from_ref(body)))
            .expect_err(&format!("limit fixture {index} must be refused"));
        assert_eq!(error.code, "OUTPUT_LIMIT", "fixture {index}: {}", error.message);
    }
}
