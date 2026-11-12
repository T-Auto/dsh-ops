//! Bounded page-tree traversal and stream decompression; repeated content is charged again as work.
use crate::{
    pdf_container::{Document, MAX_STREAM, ObjectId, decode, get},
    pdf_limits::{MAX_CONTENT_DECODED, deadline},
    pdf_syntax::{Dict, Value, bad, limit},
};
use ops_protocol::Result;
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Instant,
};
/// Pages one walk returns: the physical bound a page offset cannot move.
pub const MAX_PAGES: usize = 32;
/// One page's dictionary and the /Resources in effect for it.
pub struct Page<'a> {
    pub dict: &'a Dict,
    pub resources: Option<&'a Value>,
}
fn reference(value: &Value) -> Result<ObjectId> {
    match value {
        Value::Ref(n, g) => Ok((*n, *g)),
        _ => Err(bad("PDF page/content identity must be indirect")),
    }
}
/// Resolve the page-tree /Count as a bounded nonnegative integer; an indirect /Count is legal, so
/// its reference chain keeps its own failure instead of a misleading type error.
fn page_count(doc: &Document<'_>, dict: &Dict) -> Result<usize> {
    let value = doc.resolve(get(dict, b"Count")?).map_err(|mut failure| {
        failure.message = format!(
            "PDF page tree Count reference cannot be used: {}",
            failure.message
        );
        failure
    })?;
    value.integer().map_err(|_| {
        bad("PDF page tree Count must be a bounded nonnegative integer or an indirect reference to one")
    })
}
/// Collect at most MAX_PAGES pages in page-tree order and verify /Count against the walk.
pub fn pages<'a>(doc: &'a Document<'_>, started: Instant) -> Result<Vec<Page<'a>>> {
    let catalog = doc.object(doc.root)?.value.dict()?;
    if get(catalog, b"Type")?.name()? != b"Catalog" {
        return Err(bad("PDF Root must be a Catalog"));
    }
    let mut seen = BTreeSet::new();
    let mut output = Vec::new();
    walk(
        doc,
        reference(get(catalog, b"Pages")?)?,
        None,
        None,
        &mut seen,
        &mut output,
        started,
        0,
    )?;
    Ok(output)
}
#[allow(clippy::too_many_arguments)]
fn walk<'a>(
    doc: &'a Document<'_>,
    id: ObjectId,
    parent: Option<ObjectId>,
    inherited: Option<&'a Value>,
    seen: &mut BTreeSet<ObjectId>,
    output: &mut Vec<Page<'a>>,
    started: Instant,
    depth: usize,
) -> Result<usize> {
    deadline(started)?;
    if depth > 64 || seen.len() >= 10_000 {
        return Err(limit("PDF page tree exceeds bounded depth or nodes"));
    }
    if !seen.insert(id) {
        return Err(bad("Cyclic or aliased PDF page tree"));
    }
    let object = doc.object(id)?;
    if object.stream.is_some() {
        return Err(bad("PDF page tree node cannot be a stream"));
    }
    let dict = object.value.dict()?;
    if let Some(parent) = parent {
        if reference(get(dict, b"Parent")?)? != parent {
            return Err(bad("PDF page Parent disagrees with page tree"));
        }
    } else if dict.contains_key(b"Parent".as_slice()) {
        return Err(bad("PDF page-tree root cannot have a Parent"));
    }
    let resources = dict.get(b"Resources".as_slice()).or(inherited);
    match get(dict, b"Type")?.name()? {
        b"Page" => {
            if output.len() >= MAX_PAGES {
                return Err(limit(
                    "PDF physical scan exceeds 32 pages; paging does not bypass this bound",
                ));
            }
            output.push(Page { dict, resources });
            Ok(1)
        }
        b"Pages" => {
            let expected = page_count(doc, dict)?;
            if expected > MAX_PAGES {
                return Err(limit(
                    "PDF physical scan exceeds 32 pages; paging does not bypass this bound",
                ));
            }
            let Value::Array(kids) = get(dict, b"Kids")? else {
                return Err(bad("PDF Pages Kids must be an array"));
            };
            let mut count = 0;
            for kid in kids {
                count += walk(
                    doc,
                    reference(kid)?,
                    Some(id),
                    resources,
                    seen,
                    output,
                    started,
                    depth + 1,
                )?;
            }
            if count != expected {
                return Err(bad("PDF page Count disagrees with observed tree"));
            }
            Ok(count)
        }
        _ => Err(bad("PDF page tree node has an invalid Type")),
    }
}
/// The page content streams decoded for one file, cached by object: decoded charges each distinct
/// stream once, processed charges every page that names it.
pub struct Streams {
    cache: BTreeMap<ObjectId, Vec<u8>>,
    pub decoded: usize,
    pub processed: usize,
}
impl Streams {
    /// An empty cache with both byte counters at zero.
    pub fn new() -> Self {
        Self {
            cache: BTreeMap::new(),
            decoded: 0,
            processed: 0,
        }
    }
    fn append(
        &mut self,
        doc: &Document<'_>,
        id: ObjectId,
        started: Instant,
        output: &mut Vec<u8>,
    ) -> Result<()> {
        if !self.cache.contains_key(&id) {
            let bytes = decode(doc.object(id)?)?;
            deadline(started)?;
            if self.decoded + bytes.len() > MAX_CONTENT_DECODED {
                return Err(limit("PDF aggregate decoded streams exceed 16 MiB"));
            }
            self.decoded += bytes.len();
            self.cache.insert(id, bytes);
        }
        let bytes = &self.cache[&id];
        if self.processed + bytes.len() > MAX_CONTENT_DECODED
            || output.len() + bytes.len() > MAX_STREAM
        {
            return Err(limit(
                "PDF processed content exceeds 16 MiB total or 1 MiB per page",
            ));
        }
        self.processed += bytes.len();
        output.extend_from_slice(bytes);
        Ok(())
    }
    /// The decoded /Contents streams of page, concatenated in stream order; a non-stream entry is a
    /// parse error and more than 64 streams or the decode budget is OUTPUT_LIMIT.
    pub fn content(
        &mut self,
        doc: &Document<'_>,
        page: &Page<'_>,
        started: Instant,
    ) -> Result<Vec<u8>> {
        let Some(contents) = page.dict.get(b"Contents".as_slice()) else {
            return Ok(Vec::new());
        };
        let mut output = Vec::new();
        match contents {
            Value::Array(items) => {
                if items.len() > 64 {
                    return Err(limit("PDF page exceeds 64 content streams"));
                }
                for item in items {
                    self.append(doc, reference(item)?, started, &mut output)?;
                }
            }
            Value::Null => {}
            value => self.append(doc, reference(value)?, started, &mut output)?,
        }
        Ok(output)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf_container::parse;
    /// Emit a classic-xref PDF whose first object is `objects[0]`, and so on.
    fn emit(objects: Vec<String>) -> Vec<u8> {
        let mut pdf = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec();
        let mut offsets = vec![0];
        for (index, value) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{value}\nendobj\n", index + 1).as_bytes());
        }
        let xref = pdf.len();
        pdf.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len()).as_bytes(),
        );
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
    /// One-page classic-xref PDF; `extra` values become objects after the catalog, tree and page.
    fn build(count: &str, extra: &[&str]) -> Vec<u8> {
        let mut objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            format!("<< /Type /Pages /Kids [3 0 R] /Count {count} >>"),
            "<< /Type /Page /Parent 2 0 R >>".to_string(),
        ];
        objects.extend(extra.iter().map(|value| value.to_string()));
        emit(objects)
    }
    fn observe(count: &str, extra: &[&str]) -> Result<usize> {
        let bytes = build(count, extra);
        let document = parse(&bytes).unwrap();
        pages(&document, Instant::now()).map(|pages| pages.len())
    }
    #[test]
    fn page_count_may_be_an_indirect_or_chained_reference() {
        assert_eq!(observe("1", &[]).unwrap(), 1);
        // Issue #646: a legal page tree whose /Count is an indirect reference.
        assert_eq!(observe("4 0 R", &["1"]).unwrap(), 1);
        assert_eq!(observe("4 0 R", &["5 0 R", "1"]).unwrap(), 1);
    }
    fn rejected(count: &str, extra: &[&str], expected: &str) {
        let error = observe(count, extra).unwrap_err();
        assert_eq!(error.code, "DOCUMENT_PARSE_ERROR", "{}", error.message);
        assert!(
            error.message.contains("page tree Count"),
            "{}",
            error.message
        );
        assert!(error.message.contains(expected), "{}", error.message);
        assert!(
            !error
                .message
                .contains("Expected a bounded nonnegative PDF integer"),
            "{}",
            error.message
        );
    }
    #[test]
    fn unusable_page_count_references_name_the_count_not_a_generic_integer() {
        rejected("9 0 R", &[], "does not name an active object");
        rejected("4 0 R", &["4 0 R"], "Cyclic PDF reference");
        rejected("4 0 R", &["(one)"], "must be a bounded nonnegative integer");
        rejected("4 0 R", &["-1"], "must be a bounded nonnegative integer");
    }
}
