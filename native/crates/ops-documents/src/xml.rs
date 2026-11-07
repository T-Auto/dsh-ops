//! Strict bounded XML events; no DTD, custom entity expansion, or external resolution.
use ops_protocol::{Failure, Result};
use quick_xml::{events::Event, name::ResolveResult, reader::NsReader};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
pub fn bad(message: impl Into<String>) -> Failure {
    Failure::new("DOCUMENT_PARSE_ERROR", message.into())
}
fn valid(text: &str) -> bool {
    text.chars()
        .all(|c| matches!(c, '\t'|'\n'|'\r'|'\u{20}'..='\u{d7ff}'|'\u{e000}'..='\u{fffd}'|'\u{10000}'..='\u{10ffff}'))
}
pub fn decode(bytes: &[u8]) -> Result<String> {
    let (text, encoding) = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if !bytes.len().is_multiple_of(2) {
            return Err(Failure::new(
                "ERR_INVALID_ENCODING",
                "Odd DOCX UTF-16 byte count",
            ));
        }
        let le = bytes[0] == 0xff;
        let units = bytes[2..].as_chunks::<2>().0.iter().map(|b| {
            if le {
                u16::from_le_bytes([b[0], b[1]])
            } else {
                u16::from_be_bytes([b[0], b[1]])
            }
        });
        let text = char::decode_utf16(units)
            .collect::<std::result::Result<String, _>>()
            .map_err(|_| Failure::new("ERR_INVALID_ENCODING", "Invalid DOCX UTF-16 surrogate"))?;
        (text, if le { "utf-16le" } else { "utf-16be" })
    } else {
        (
            std::str::from_utf8(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes))
                .map_err(|_| {
                    Failure::new(
                        "ERR_INVALID_ENCODING",
                        "DOCX XML must be strict UTF-8 or BOM-marked UTF-16",
                    )
                })?
                .to_owned(),
            "utf-8",
        )
    };
    if !valid(&text) {
        return Err(bad("Invalid XML 1.0 character"));
    }
    let mut reader = NsReader::from_str(&text);
    if let Event::Decl(decl) = reader.read_event().map_err(|e| bad(e.to_string()))? {
        if decl.version().map_err(|e| bad(e.to_string()))? != "1.0" {
            return Err(bad("Only XML 1.0 is supported"));
        }
        if let Some(declared) = decl.encoding() {
            let declared = declared
                .map_err(|e| bad(e.to_string()))?
                .to_ascii_lowercase();
            if declared != encoding && !(declared == "utf-16" && encoding.starts_with("utf-16")) {
                return Err(Failure::new(
                    "ERR_INVALID_ENCODING",
                    "DOCX XML encoding declaration disagrees with actual bytes",
                ));
            }
        }
    }
    Ok(text)
}
pub struct Tag {
    pub ns: String,
    pub name: String,
    pub attrs: BTreeMap<String, String>,
}
pub enum Token {
    Start(Tag),
    End(String),
    Text(String),
}
pub fn walk(
    text: &str,
    started: Instant,
    mut visit: impl FnMut(Token) -> Result<()>,
) -> Result<()> {
    let mut reader = NsReader::from_str(text);
    reader.config_mut().check_comments = true;
    reader.resolver_mut().set_max_namespace_bindings(512);
    let (mut depth, mut roots, mut declaration, mut events) = (0usize, 0usize, false, 0usize);
    loop {
        if started.elapsed() > Duration::from_secs(30) {
            return Err(Failure::new(
                "DEADLINE_EXCEEDED",
                "Document parse reached its 30-second deadline",
            ));
        }
        let event = reader
            .read_event()
            .map_err(|e| bad(format!("Invalid DOCX XML: {e}")))?;
        match event {
            Event::Start(ref tag) | Event::Empty(ref tag) => {
                if depth == 0 {
                    roots += 1;
                    if roots > 1 {
                        return Err(bad("XML has multiple roots"));
                    }
                }
                if depth >= 128 {
                    return Err(Failure::new(
                        "OUTPUT_LIMIT",
                        "DOCX XML exceeds 128 nesting levels",
                    ));
                }
                let (ns, name) = reader.resolver().resolve_element(tag.name());
                let ns = match ns {
                    ResolveResult::Bound(ns) => ns.as_ref().to_owned(),
                    _ => return Err(bad("DOCX XML element has no recognized namespace binding")),
                };
                let name = name.as_ref().to_owned();
                let mut attrs = BTreeMap::new();
                for (index, attr) in tag.attributes().enumerate() {
                    if index >= 64 {
                        return Err(Failure::new(
                            "OUTPUT_LIMIT",
                            "DOCX element exceeds 64 attributes",
                        ));
                    }
                    let attr = attr.map_err(|e| bad(e.to_string()))?;
                    let value = attr
                        .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                        .map_err(|e| bad(e.to_string()))?
                        .into_owned();
                    if !valid(&value) {
                        return Err(bad("Invalid XML attribute character reference"));
                    }
                    if attr.key.as_ref() != "xmlns"
                        && !attr.key.as_ref().starts_with("xmlns:")
                        && matches!(
                            reader.resolver().resolve_attribute(attr.key).0,
                            ResolveResult::Unknown(_)
                        )
                    {
                        return Err(bad("Unbound XML attribute namespace"));
                    }
                    attrs.insert(attr.key.as_ref().to_owned(), value);
                }
                visit(Token::Start(Tag {
                    ns: ns.clone(),
                    name: name.clone(),
                    attrs,
                }))?;
                if matches!(event, Event::Empty(_)) {
                    visit(Token::End(name))?;
                } else {
                    depth += 1;
                }
            }
            Event::End(tag) => {
                let (ns, name) = reader.resolver().resolve_element(tag.name());
                if !matches!(ns, ResolveResult::Bound(_)) {
                    return Err(bad("Unbound DOCX XML closing element"));
                }
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| bad("Unexpected XML closing element"))?;
                visit(Token::End(name.as_ref().to_owned()))?;
            }
            Event::Text(value) => {
                if depth == 0 && !value.trim().is_empty() {
                    return Err(bad("Text outside XML root"));
                }
                visit(Token::Text(value.xml10_content().into_owned()))?;
            }
            Event::CData(value) => {
                if depth == 0 {
                    return Err(bad("CDATA outside XML root"));
                }
                visit(Token::Text(value.xml10_content().into_owned()))?;
            }
            Event::GeneralRef(value) => {
                if depth == 0 {
                    return Err(bad("Entity outside XML root"));
                }
                let escaped = format!("&{};", value.as_ref());
                let expanded =
                    quick_xml::escape::unescape(&escaped).map_err(|e| bad(e.to_string()))?;
                if !valid(&expanded) {
                    return Err(bad("Invalid XML character reference"));
                }
                visit(Token::Text(expanded.into_owned()))?;
            }
            Event::DocType(_) => return Err(bad("DTD and custom entities are unsupported")),
            Event::Decl(_) => {
                if declaration || roots != 0 || events != 0 {
                    return Err(bad("Misplaced XML declaration"));
                }
                declaration = true;
            }
            Event::Eof => {
                if roots != 1 || depth != 0 {
                    return Err(bad("Incomplete XML document"));
                }
                return Ok(());
            }
            _ => {}
        }
        events += 1;
    }
}
