use super::*;
fn fixture(values: &[&[u8]]) -> Vec<u8> {
    let mut pdf = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = vec![0];
    for (index, value) in values.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        pdf.extend_from_slice(value);
        pdf.extend_from_slice(b"\nendobj\n");
    }
    let xref = pdf.len();
    pdf.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len()).as_bytes());
    for offset in offsets.iter().skip(1) {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            offsets.len()
        )
        .as_bytes(),
    );
    pdf
}
fn replace(pdf: &[u8], old: &[u8], new: &[u8]) -> Vec<u8> {
    let at = pdf.windows(old.len()).position(|v| v == old).unwrap();
    [&pdf[..at], new, &pdf[at + old.len()..]].concat()
}
fn rejected(pdf: &[u8], code: &str) {
    let error = parse(pdf).unwrap_err();
    assert_eq!(error.code, code, "{}", error.message);
}
#[test]
fn real_classic_pdf_preserves_objects_values_and_exact_stream_bytes() {
    let pdf = fixture(&[
        b"<< /Type /Catalog /Pages 2 0 R /A true /B false /N null /Escaped#20Name <4f70 7> >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
        b"<< /Length 9 >>\nstream\n(Hi) Tj\n\nendstream",
    ]);
    let document = parse(&pdf).unwrap();
    assert_eq!(document.objects.len(), 4);
    assert_eq!(
        document.object((4, 0)).unwrap().stream,
        Some(b"(Hi) Tj\n\n".as_slice())
    );
    let root = document
        .object(document.root)
        .unwrap()
        .value
        .dict()
        .unwrap();
    assert!(matches!(get(root, b"A").unwrap(), Value::Bool(true)));
    assert!(matches!(get(root, b"B").unwrap(), Value::Bool(false)));
    assert!(matches!(get(root, b"Escaped Name").unwrap(), Value::String(v) if v == b"Opp"));
}
#[test]
fn literal_strings_escapes_line_endings_and_odd_hex_are_exact() {
    let mut lexer = Lexer::new(b"(a\\n\\r\\t\\b\\f\\(b\\)\\134\\101\\\r\nc\r\nd)");
    assert!(
        matches!(lexer.value(0).unwrap(), Value::String(v) if v == b"a\n\r\t\x08\x0c(b)\\Ac\nd")
    );
    let mut lexer = Lexer::new(b"<123>");
    assert!(matches!(lexer.value(0).unwrap(), Value::String(v) if v == [0x12,0x30]));
    assert!(Lexer::new(b"1.0").value(0).unwrap().integer().is_err());
    assert!(Lexer::new(b"+1").value(0).unwrap().integer().is_ok());
}
#[test]
fn duplicate_keys_and_escaped_unsupported_names_are_rejected() {
    for value in [
        b"<< /Name 1 /Na#6de 2 >>".as_slice(),
        b"<< /Bad#0 1 >>",
        b"<< /Bad#00 1 >>",
        b"<< /Na#GG 1 >>",
    ] {
        rejected(&fixture(&[value]), "DOCUMENT_PARSE_ERROR");
    }
    for name in ["Encrypt", "Enc#72ypt", "ObjStm", "XRef"] {
        rejected(
            &fixture(&[format!("<< /{name} null >>").as_bytes()]),
            "UNSUPPORTED_DOCUMENT",
        );
    }
}
#[test]
fn outline_prev_is_an_ordinary_key_while_a_trailer_prev_stays_unsupported() {
    // An outline item names its previous sibling with /Prev, which is not an
    // incremental-update marker; refusing the token made the whole document
    // unreadable (#427).
    let pdf = fixture(&[
        b"<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >>",
        b"<< /Type /Pages /Kids [] /Count 0 >>",
        b"<< /Type /Outlines /First 4 0 R /Last 5 0 R /Count 2 >>",
        b"<< /Title (First) /Parent 3 0 R /Next 5 0 R >>",
        b"<< /Title (Second) /Parent 3 0 R /Prev 4 0 R /XRefStm 4 0 R >>",
    ]);
    let document = parse(&pdf).unwrap();
    let second = document.object((5, 0)).unwrap().value.dict().unwrap();
    assert!(matches!(get(second, b"Prev").unwrap(), Value::Ref(4, 0)));
    // The same names still refuse a file that really has an earlier xref section.
    for key in [b"/Prev".as_slice(), b"/Pr#65v", b"/XRefStm"] {
        let mut trailer = b"/Root 1 0 R ".to_vec();
        trailer.extend_from_slice(key);
        trailer.extend_from_slice(b" 9 0 R >>");
        rejected(
            &replace(&pdf, b"/Root 1 0 R >>", &trailer),
            "UNSUPPORTED_DOCUMENT",
        );
    }
}
#[test]
fn offset_alias_overlap_and_unindexed_data_are_never_recovered() {
    let pdf = fixture(&[b"<<>>", b"(value)"]);
    let document = parse(&pdf).unwrap();
    assert_eq!(document.objects.len(), 2);
    let first = pdf.windows(7).position(|w| w == b"1 0 obj").unwrap();
    let second = pdf.windows(7).position(|w| w == b"2 0 obj").unwrap();
    rejected(
        &replace(
            &pdf,
            format!("{second:010}").as_bytes(),
            format!("{first:010}").as_bytes(),
        ),
        "DOCUMENT_PARSE_ERROR",
    );
    rejected(
        &replace(
            &pdf,
            format!("{first:010}").as_bytes(),
            format!("{:010}", first - 1).as_bytes(),
        ),
        "DOCUMENT_PARSE_ERROR",
    );
    rejected(
        &replace(&pdf, b"2 0 obj", b"2 1 obj"),
        "DOCUMENT_PARSE_ERROR",
    );
    rejected(
        &replace(&pdf, b"%\xE2\xE3\xCF\xD3", b"xxxxx"),
        "DOCUMENT_PARSE_ERROR",
    );
    // A comment starting before an indexed object must not allow that object to become executable.
    rejected(
        &replace(&pdf, b"\n2 0 obj", b"%2 0 obj"),
        "DOCUMENT_PARSE_ERROR",
    );
}
#[test]
fn xref_counts_generations_size_and_footer_are_bounded_and_exact() {
    let pdf = fixture(&[b"<<>>"]);
    for (old, new) in [
        (b"xref\n0 2".as_slice(), b"xref\n0 1000000000".as_slice()),
        (b"xref\n0 2", b"xref\n10000 2"),
    ] {
        rejected(&replace(&pdf, old, new), "OUTPUT_LIMIT");
    }
    for (old, new) in [
        (b"/Size 2".as_slice(), b"/Size 3".as_slice()),
        (b"/Size 2", b"/Size 2.0"),
        (b"65535 f", b"65534 f"),
        (b"00000 n", b"99999 n"),
        (b"00000 n", b"00000 x"),
        (b"startxref\n", b"startxref"),
        (b"%%EOF\n", b"%%EOF x"),
        (b"xref\n0 2", b"xref\n0 1"),
    ] {
        rejected(&replace(&pdf, old, new), "DOCUMENT_PARSE_ERROR");
    }
}
#[test]
fn streams_require_bounded_direct_integer_lengths_and_matching_end() {
    for value in [
        b"<< /Length 1.0 >>\nstream\nx\nendstream".as_slice(),
        b"<< /Length 1 0 R >>\nstream\nx\nendstream",
        b"<< /Length 3 >>\nstream\nx\nendstream",
        b"<< /Length 100000 >>\nstream\nx\nendstream",
        b"<< /Length 1 >>\nstream x\nendstream",
        b"<< /Length 1 >>\nstream\nx\nendobj",
    ] {
        rejected(&fixture(&[value]), "DOCUMENT_PARSE_ERROR");
    }
    rejected(
        &fixture(&[b"<< /Length 1048577 >>\nstream\nx\nendstream"]),
        "OUTPUT_LIMIT",
    );
    let pdf = fixture(&[b"<<>>", b"<< /Length 0 >>\nstream\nendstream"]);
    assert_eq!(
        parse(&pdf).unwrap().object((2, 0)).unwrap().stream,
        Some(b"".as_slice())
    );
}
#[test]
fn nesting_strings_names_and_node_totals_are_bounded() {
    let deep = format!("<< /X {}0{} >>", "[".repeat(65), "]".repeat(65));
    rejected(&fixture(&[deep.as_bytes()]), "OUTPUT_LIMIT");
    let name = format!("<< /{} 0 >>", "a".repeat(257));
    rejected(&fixture(&[name.as_bytes()]), "OUTPUT_LIMIT");
    let nodes = format!("<< /X [{}] >>", "0 ".repeat(100000));
    rejected(&fixture(&[nodes.as_bytes()]), "OUTPUT_LIMIT");
    let string = format!("<< /X ({}) >>", "x".repeat(1024 * 1024 + 1));
    rejected(&fixture(&[string.as_bytes()]), "OUTPUT_LIMIT");
    let hex = format!("<< /X <{}> >>", "a".repeat(2 * 1024 * 1024 + 1));
    rejected(&fixture(&[hex.as_bytes()]), "OUTPUT_LIMIT");
    rejected(&vec![b' '; MAX_FILE + 1], "OUTPUT_LIMIT");
}
#[test]
fn reference_resolution_is_bounded_and_cycles_missing_objects_fail() {
    let pdf = fixture(&[b"<< /X 2 0 R >>", b"3 0 R", b"2 0 R"]);
    let doc = parse(&pdf).unwrap();
    let value = get(doc.object(doc.root).unwrap().value.dict().unwrap(), b"X").unwrap();
    assert_eq!(doc.resolve(value).unwrap_err().code, "DOCUMENT_PARSE_ERROR");
    assert!(doc.resolve(&Value::Ref(999, 0)).is_err());
    let mut values = vec![b"<<>>".to_vec()];
    for n in 2..68 {
        values.push(format!("{} 0 R", n + 1).into_bytes());
    }
    values.push(b"null".to_vec());
    let pdf = fixture(&values.iter().map(Vec::as_slice).collect::<Vec<_>>());
    assert_eq!(
        parse(&pdf)
            .unwrap()
            .resolve(&Value::Ref(2, 0))
            .unwrap_err()
            .code,
        "OUTPUT_LIMIT"
    );
}
#[test]
fn every_truncated_prefix_and_single_byte_mutation_is_panic_free() {
    let pdf = fixture(&[
        b"<< /Type /Catalog /X [(a\\)b) <abc> 1 -2 3.5] >>",
        b"<< /Length 2 >>\nstream\nxy\nendstream",
    ]);
    for end in 0..pdf.len() {
        assert!(parse(&pdf[..end]).is_err() || trim_end(&pdf[..end]).ends_with(b"%%EOF"));
    }
    for at in 0..pdf.len() {
        for byte in [0, b'%', b'(', b'<', b'9', 255] {
            let mut changed = pdf.clone();
            changed[at] = byte;
            let _ = parse(&changed);
        }
    }
}
#[test]
fn flate_streams_validate_actual_decoded_size_checksum_and_consumption() {
    use std::io::Write;
    fn zipped(bytes: &[u8]) -> Vec<u8> {
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }
    fn decode_zip(bytes: &[u8]) -> ops_protocol::Result<Vec<u8>> {
        let mut dict = Dict::new();
        dict.insert(b"Filter".to_vec(), Value::Name(b"FlateDecode".to_vec()));
        decode(&Object {
            value: Value::Dict(dict),
            stream: Some(bytes),
        })
    }
    let text = b"BT /F1 12 Tf (A real PDF text stream) Tj ET";
    let compressed = zipped(text);
    assert_eq!(decode_zip(&compressed).unwrap(), text);
    for length in 0..compressed.len() {
        assert_eq!(
            decode_zip(&compressed[..length]).unwrap_err().code,
            "DOCUMENT_PARSE_ERROR"
        );
    }
    let mut trailing = compressed.clone();
    trailing.push(0);
    assert_eq!(
        decode_zip(&trailing).unwrap_err().code,
        "DOCUMENT_PARSE_ERROR"
    );
    let mut corrupt = compressed.clone();
    let end = corrupt.len() - 1;
    corrupt[end] ^= 1;
    assert_eq!(
        decode_zip(&corrupt).unwrap_err().code,
        "DOCUMENT_PARSE_ERROR"
    );
    assert_eq!(
        decode_zip(&zipped(&vec![b'x'; MAX_STREAM])).unwrap().len(),
        MAX_STREAM
    );
    assert_eq!(
        decode_zip(&zipped(&vec![b'x'; MAX_STREAM + 1]))
            .unwrap_err()
            .code,
        "OUTPUT_LIMIT"
    );
    let raw = Object {
        value: Value::Dict(Dict::new()),
        stream: Some(text),
    };
    assert_eq!(decode(&raw).unwrap(), text);
}
#[test]
fn filter_chains_predictors_and_external_streams_are_declined() {
    for (key, value) in [
        (b"Filter".as_slice(), Value::Name(b"LZWDecode".to_vec())),
        (
            b"Filter",
            Value::Array(vec![Value::Name(b"FlateDecode".to_vec()); 2]),
        ),
        (b"DecodeParms", Value::Null),
        (b"F", Value::String(b"file.pdf".to_vec())),
    ] {
        let mut dict = Dict::new();
        dict.insert(key.to_vec(), value);
        assert!(
            decode(&Object {
                value: Value::Dict(dict),
                stream: Some(b"")
            })
            .is_err()
        );
    }
}
#[test]
fn stream_roots_reserved_generations_and_direct_oversize_decode_are_refused() {
    rejected(
        &fixture(&[b"<< /Length 0 >>\nstream\nendstream"]),
        "DOCUMENT_PARSE_ERROR",
    );
    let pdf = fixture(&[b"<<>>"]);
    rejected(
        &replace(&pdf, b"00000 n", b"65535 n"),
        "DOCUMENT_PARSE_ERROR",
    );
    let bytes = vec![0; MAX_STREAM + 1];
    let raw = Object {
        value: Value::Dict(Dict::new()),
        stream: Some(&bytes),
    };
    assert_eq!(decode(&raw).unwrap_err().code, "OUTPUT_LIMIT");
}
