//! PDF builders and the public `read_pdf` harness shared by the integration matrices.
#![allow(dead_code)]

use ops_protocol::{Failure, Request};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};

pub const HEADER: &[u8] = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
pub const CATALOG: &[u8] = b"<< /Type /Catalog /Pages 2 0 R >>";
pub const PAGES: &[u8] = b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
pub const PAGE: &[u8] = b"<< /Type /Page /Parent 2 0 R >>";
pub const HELVETICA: &[u8] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

/// One `/W [1 4 2]` cross-reference stream row.
pub fn row(kind: u8, second: u32, third: u16) -> [u8; 7] {
    let mut bytes = [0u8; 7];
    bytes[0] = kind;
    bytes[1..5].copy_from_slice(&second.to_be_bytes());
    bytes[5..].copy_from_slice(&third.to_be_bytes());
    bytes
}

/// One `/W [1 4 1]` row; a one-byte generation field cannot hold 65535.
pub fn narrow_row(kind: u8, second: u32, third: u8) -> [u8; 6] {
    let mut bytes = [0u8; 6];
    bytes[0] = kind;
    bytes[1..5].copy_from_slice(&second.to_be_bytes());
    bytes[5] = third;
    bytes
}

fn adler32(data: &[u8]) -> u32 {
    let (mut low, mut high) = (1u32, 0u32);
    for byte in data {
        low = (low + u32::from(*byte)) % 65521;
        high = (high + low) % 65521;
    }
    (high << 16) | low
}

/// A zlib stream whose deflate blocks store their input; integration tests carry no compressor.
pub fn zlib(data: &[u8]) -> Vec<u8> {
    let mut output = vec![0x78, 0x01];
    let chunks: Vec<&[u8]> = if data.is_empty() {
        vec![&[]]
    } else {
        data.chunks(65_535).collect()
    };
    for (index, chunk) in chunks.iter().enumerate() {
        let last = index + 1 == chunks.len();
        output.push(u8::from(last));
        let length = chunk.len() as u16;
        output.extend_from_slice(&length.to_le_bytes());
        output.extend_from_slice(&(!length).to_le_bytes());
        output.extend_from_slice(chunk);
    }
    output.extend_from_slice(&adler32(data).to_be_bytes());
    output
}

/// An unfiltered stream object body with a direct `/Length`.
pub fn stream(entries: &str, body: &[u8]) -> Vec<u8> {
    stream_with_length(&body.len().to_string(), entries, body)
}

/// An unfiltered stream object body whose `/Length` is written verbatim, as an indirect reference.
pub fn stream_with_length(length: &str, entries: &str, body: &[u8]) -> Vec<u8> {
    let mut object = format!("<< /Length {length}{entries} >>\nstream\n").into_bytes();
    object.extend_from_slice(body);
    object.extend_from_slice(b"\nendstream");
    object
}

/// Decoded object-stream bytes and the `/First` offset for the given inner objects.
pub fn object_stream(objects: &[(u32, &[u8])]) -> (Vec<u8>, usize) {
    let mut header = String::new();
    let mut offset = 0;
    for (number, body) in objects {
        header.push_str(&format!("{number} {offset} "));
        offset += body.len() + 1;
    }
    let first = header.len();
    let mut decoded = header.into_bytes();
    for (_, body) in objects {
        decoded.extend_from_slice(body);
        decoded.push(b' ');
    }
    (decoded, first)
}

/// A PDF under construction that records the offset of every numbered object it writes.
pub struct Pdf {
    pub bytes: Vec<u8>,
    pub offsets: BTreeMap<usize, usize>,
}

impl Pdf {
    pub fn new() -> Self {
        Self {
            bytes: HEADER.to_vec(),
            offsets: BTreeMap::new(),
        }
    }

    /// Write the next object number and return it.
    pub fn object(&mut self, body: &[u8]) -> usize {
        let number = self.offsets.keys().next_back().map_or(1, |last| last + 1);
        self.numbered(number, body);
        number
    }

    /// Write one explicit object number; a later revision may reuse a superseded number.
    pub fn numbered(&mut self, number: usize, body: &[u8]) {
        self.offsets.insert(number, self.bytes.len());
        self.bytes
            .extend_from_slice(format!("{number} 0 obj\n").as_bytes());
        self.bytes.extend_from_slice(body);
        self.bytes.extend_from_slice(b"\nendobj\n");
    }

    /// Write a Flate-encoded stream object.
    pub fn stream(&mut self, dict: &str, data: &[u8]) -> usize {
        let compressed = zlib(data);
        let mut body = format!(
            "<< {dict} /Filter /FlateDecode /Length {} >>\nstream\n",
            compressed.len()
        )
        .into_bytes();
        body.extend_from_slice(&compressed);
        body.extend_from_slice(b"\nendstream");
        self.object(&body)
    }

    /// Append a classic xref table covering objects `1..=count`, then its trailer.
    pub fn classic_section(&mut self, count: usize, size: usize, trailer: &str) -> usize {
        let xref = self.bytes.len();
        self.bytes
            .extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", count + 1).as_bytes());
        for number in 1..=count {
            self.bytes
                .extend_from_slice(format!("{:010} 00000 n \n", self.offsets[&number]).as_bytes());
        }
        self.bytes.extend_from_slice(
            format!("trailer\n<< /Size {size} {trailer} >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
        );
        xref
    }

    /// Append an empty incremental revision whose trailer only follows `/Prev`.
    pub fn empty_revision(&mut self, size: usize, trailer: &str) -> usize {
        let current = self.bytes.len();
        self.bytes.extend_from_slice(
            format!(
                "xref\n0 0\ntrailer\n<< /Size {size} {trailer} >>\nstartxref\n{current}\n%%EOF\n"
            )
            .as_bytes(),
        );
        current
    }

    /// Close with a Flate cross-reference stream covering every written object plus itself.
    pub fn finish_xref_stream(self, extra: &str) -> Vec<u8> {
        self.close_xref_stream(extra, false)
    }

    /// The same close, but the rows are tagged PNG Up rows (`Predictor 12`).
    pub fn finish_png_xref(self, extra: &str) -> Vec<u8> {
        self.close_xref_stream(extra, true)
    }

    fn close_xref_stream(mut self, extra: &str, png: bool) -> Vec<u8> {
        let last = *self
            .offsets
            .keys()
            .next_back()
            .expect("at least one object");
        let size = last + 2;
        let stream_offset = self.bytes.len();
        let mut rows = vec![row(0, 0, 65_535)];
        for number in 1..=last {
            rows.push(row(1, self.offsets[&number] as u32, 0));
        }
        rows.push(row(1, stream_offset as u32, 0));
        let decoded = if png { png_up(&rows) } else { rows.concat() };
        let parms = if png {
            " /DecodeParms << /Predictor 12 /Columns 7 >>"
        } else {
            ""
        };
        self.stream(
            &format!(
                "/Type /XRef /Size {size} /W [1 4 2] /Index [0 {size}] /Root 1 0 R{parms} {extra}"
            ),
            &decoded,
        );
        self.bytes
            .extend_from_slice(format!("startxref\n{stream_offset}\n%%EOF\n").as_bytes());
        self.bytes
    }
}

fn png_up(rows: &[[u8; 7]]) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(rows.len() * 8);
    let mut prior = [0u8; 7];
    for row in rows {
        encoded.push(2);
        for (at, byte) in row.iter().enumerate() {
            encoded.push(byte.wrapping_sub(prior[at]));
        }
        prior = *row;
    }
    encoded
}

/// A one-page classic-xref PDF from object bodies in object-number order.
pub fn classic(objects: &[Vec<u8>]) -> Vec<u8> {
    let mut pdf = Pdf::new();
    for body in objects {
        pdf.object(body);
    }
    let size = objects.len() + 1;
    pdf.classic_section(objects.len(), size, "/Root 1 0 R");
    pdf.bytes
}

/// A one-page text PDF; page `i` shows `texts[i]` in Helvetica.
pub fn text_document(texts: &[&str]) -> Vec<u8> {
    let first_page = 3;
    let first_content = first_page + texts.len();
    let kids = (0..texts.len())
        .map(|index| format!("{} 0 R", first_page + index))
        .collect::<Vec<_>>()
        .join(" ");
    let mut objects = vec![
        CATALOG.to_vec(),
        format!("<< /Type /Pages /Kids [{kids}] /Count {} >>", texts.len()).into_bytes(),
    ];
    for index in 0..texts.len() {
        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 {} 0 R >> >> /Contents {} 0 R >>",
                first_content + texts.len(),
                first_content + index
            )
            .into_bytes(),
        );
    }
    for text in texts {
        let content = format!("BT /F1 12 Tf ({text}) Tj ET");
        objects.push(stream("", content.as_bytes()));
    }
    objects.push(HELVETICA.to_vec());
    classic(&objects)
}

/// A one-page PDF whose `/F1` font is `font`; `objects` become `6 0 obj` onward.
/// The page content is object 5 and shows `content`.
pub fn font_document(font: &str, objects: &[Vec<u8>], content: &[u8]) -> Vec<u8> {
    let mut all = vec![
        CATALOG.to_vec(),
        PAGES.to_vec(),
        b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
            .to_vec(),
        font.as_bytes().to_vec(),
        stream("", content),
    ];
    all.extend(objects.iter().cloned());
    classic(&all)
}

/// A ToUnicode CMap over `codespace` with `body` after it.
pub fn cmap(codespace: &str, body: &str) -> Vec<u8> {
    format!(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n\
         /CMapType 2 def\n1 begincodespacerange\n{codespace}\nendcodespacerange\n{body}\n\
         endcmap CMapName currentdict /CMap defineresource pop end end\n"
    )
    .into_bytes()
}

/// The single page's text.
pub fn text(output: &Value) -> &str {
    output["items"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("page text: {output}"))
}

/// One PDF on disk; removed when the test ends, including on panic.
pub struct TempPdf(PathBuf);

impl TempPdf {
    pub fn write(bytes: &[u8]) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "pdf-matrix-{}-{}.pdf",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, bytes).expect("write temporary PDF");
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// Run `read_pdf` as worker dispatch does; `extra` overrides window arguments.
    pub fn read(&self, extra: Value) -> Result<Value, Failure> {
        let path = self.path();
        let root = path
            .parent()
            .expect("scratch directory")
            .to_string_lossy()
            .into_owned();
        let mut args = json!({ "path": path.to_string_lossy() });
        if let Value::Object(fields) = extra {
            for (key, value) in fields {
                args[key.as_str()] = value;
            }
        }
        let request: Request = serde_json::from_value(json!({
            "root": root,
            "scope": "pdf-matrix",
            "tool": "read_pdf",
            "args": args,
        }))
        .expect("worker request");
        ops_documents::dispatch(&request)
    }
}

impl Drop for TempPdf {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Write `bytes` and run the public `read_pdf` tool with `extra` arguments.
pub fn read(bytes: &[u8], extra: Value) -> Result<Value, Failure> {
    TempPdf::write(bytes).read(extra)
}

/// The failed page numbers and codes, in page order.
pub fn failed_pages(output: &Value) -> Vec<(u64, String)> {
    output["failedPages"]
        .as_array()
        .unwrap_or_else(|| panic!("failedPages array: {output}"))
        .iter()
        .map(|entry| {
            let page = entry["page"].as_u64().expect("page number");
            let code = entry["code"].as_str().expect("failure code").to_owned();
            (page, code)
        })
        .collect()
}
