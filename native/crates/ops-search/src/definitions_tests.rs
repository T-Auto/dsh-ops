//! Tests for the lexical declaration classifier and the `grep` definitions mode.

use super::{Kind, classify, whole_identifier};
use crate::dispatch;
use ops_protocol::Request;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn kind(extension: &str, line: &str, needle: &str) -> Option<Kind> {
    let start = line
        .find(needle)
        .unwrap_or_else(|| panic!("{needle:?} is not in {line:?}"));
    classify(extension, line, start, start + needle.len())
}

fn fixture(tag: &str) -> Fixture {
    Fixture::new(tag)
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("dsh-ops-grep-def-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self { root }
    }

    fn file(&self, name: &str, contents: &str) {
        let path = self.root.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn request(root: &Path, args: Value) -> Request {
    serde_json::from_value(
        json!({"root": root, "scope": "grep-definitions", "tool": "grep", "args": args}),
    )
    .unwrap()
}

fn run(root: &Path, args: Value) -> Value {
    dispatch(&request(root, args)).unwrap()
}

fn refusal(root: &Path, args: Value) -> String {
    dispatch(&request(root, args)).unwrap_err().code
}

#[test]
fn declaration_verbs_are_recognised_across_languages() {
    let cases = [
        (
            "ts",
            "export async function greet(name: string) {",
            "greet",
            Some(Kind::Function),
        ),
        (
            "ts",
            "export default class Greeter {",
            "Greeter",
            Some(Kind::Type),
        ),
        ("ts", "interface Options {", "Options", Some(Kind::Type)),
        (
            "ts",
            "const greet = (name: string) => name",
            "greet",
            Some(Kind::Function),
        ),
        ("ts", "const greet = 1", "greet", Some(Kind::Variable)),
        ("ts", "  greet(name: string) {", "greet", Some(Kind::Method)),
        ("ts", "  // function greet(name: string) {", "greet", None),
        (
            "ts",
            "const text = \"function greet(name) {\";",
            "greet",
            None,
        ),
        ("ts", "if (greet('x')) {", "greet", None),
        (
            "js",
            "export default function greet() {",
            "greet",
            Some(Kind::Function),
        ),
        (
            "rs",
            "pub fn greet(name: &str) {",
            "greet",
            Some(Kind::Function),
        ),
        (
            "rs",
            "pub(crate) struct Greeter {",
            "Greeter",
            Some(Kind::Type),
        ),
        ("rs", "macro_rules! greet {", "greet", Some(Kind::Macro)),
        ("py", "def greet(name):", "greet", Some(Kind::Function)),
        (
            "py",
            "greet = lambda value: value",
            "greet",
            Some(Kind::Function),
        ),
        ("py", "greet = 1", "greet", Some(Kind::Variable)),
        (
            "go",
            "func Greet(name string) {",
            "Greet",
            Some(Kind::Function),
        ),
        (
            "go",
            "func (r *Receiver) Greet(name string) {",
            "Greet",
            Some(Kind::Method),
        ),
        ("cs", "public void greet() {", "greet", Some(Kind::Method)),
        ("c", "#define GREET(x) ((x)+1)", "GREET", Some(Kind::Macro)),
        ("sh", "greet() {", "greet", Some(Kind::Method)),
        (
            "ts",
            "function 问候(name: string) {",
            "问候",
            Some(Kind::Function),
        ),
    ];
    for (extension, line, needle, expected) in cases {
        assert_eq!(
            kind(extension, line, needle),
            expected,
            "{extension}: {line}"
        );
    }
}

#[test]
fn a_fragment_of_a_longer_identifier_is_not_the_identifier() {
    assert!(!whole_identifier("const getUser = 1", 6, 9));
    assert!(whole_identifier("function greet(name: string) {", 9, 14));
    assert!(whole_identifier("const 名字 = 1", 6, 12));
    assert!(whole_identifier("greet('x')", 0, 5));
}

#[test]
fn object_properties_and_imports_are_references() {
    for (extension, line) in [
        ("ts", "const value = { greet: () => 'x' };"),
        ("ts", "import { greet } from './greet.js';"),
        ("ts", "export { greet };"),
        ("ts", "const options = { greet };"),
    ] {
        assert_eq!(kind(extension, line, "greet"), None, "{line}");
    }
}

#[test]
fn definitions_mode_returns_only_declaration_lines() {
    let fixture = fixture("only-declarations");
    fixture.file(
        "src/greet.ts",
        "export function greet(name: string) {\n  return name\n}\nconst call = greet('a')\n",
    );
    fixture.file("src/calls.ts", "greet('b')\nconst other = greet('c')\n");
    fixture.file("notes.md", "greet is a function in prose\n");
    let value = run(
        &fixture.root,
        json!({"path": fixture.root, "pattern": "greet", "outputMode": "definitions"}),
    );
    assert_eq!(value["status"], "completed", "{value}");
    let items = value["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{value}");
    assert_eq!(items[0]["line"], 1, "{value}");
    assert_eq!(items[0]["kind"], "function", "{value}");
    assert!(items[0]["path"].as_str().unwrap().ends_with("greet.ts"));
    assert!(
        items[0]["text"]
            .as_str()
            .unwrap()
            .contains("function greet")
    );
    // Five lines contain the identifier (including the prose line); one is a declaration.
    assert_eq!(value["matched"], 5, "{value}");
    assert_eq!(value["total"], 1, "{value}");
    assert_eq!(value["complete"], true, "{value}");
}

#[test]
fn content_mode_is_unchanged() {
    let fixture = fixture("content-unchanged");
    fixture.file("src/greet.ts", "function greet() {}\ngreet()\n");
    let value = run(
        &fixture.root,
        json!({"path": fixture.root, "pattern": "greet"}),
    );
    assert_eq!(value["items"].as_array().unwrap().len(), 2, "{value}");
    assert_eq!(value["matched"], 2, "{value}");
}

#[test]
fn definitions_mode_rejects_rows_it_cannot_classify() {
    let fixture = fixture("refuses-shapes");
    fixture.file("a.ts", "function greet() {}\n");
    assert_eq!(
        refusal(
            &fixture.root,
            json!({"path": fixture.root, "pattern": "greet", "outputMode": "definitions", "multiline": true})
        ),
        "INVALID_ARGUMENT"
    );
    assert_eq!(
        refusal(
            &fixture.root,
            json!({"path": fixture.root, "pattern": "greet", "outputMode": "definitions", "beforeContext": 1})
        ),
        "INVALID_ARGUMENT"
    );
}

#[test]
fn definitions_mode_pages_the_declaration_domain() {
    let fixture = fixture("paged");
    fixture.file("a.ts", "function greet() {}\n");
    fixture.file("b.ts", "const greet = 1;\n");
    fixture.file("c.ts", "greet();\n");
    let args =
        json!({"path": fixture.root, "pattern": "greet", "outputMode": "definitions", "limit": 1});
    let first = run(&fixture.root, args.clone());
    let items = first["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{first}");
    assert_eq!(first["total"], 2, "{first}");
    assert_eq!(first["omitted"], 1, "{first}");
    assert_eq!(first["nextOffset"], 1, "{first}");
    let continuation = first["continuation"].as_str().unwrap().to_string();
    let mut next = args;
    next["continuation"] = json!(continuation);
    let second = run(&fixture.root, next);
    let items = second["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{second}");
    assert_eq!(items[0]["kind"], "variable", "{second}");
}

#[test]
fn a_reference_only_scan_reports_no_declaration_honestly() {
    let fixture = fixture("reference-only");
    fixture.file("calls.ts", "greet('a')\ngreet('b')\n");
    let value = run(
        &fixture.root,
        json!({"path": fixture.root, "pattern": "greet", "outputMode": "definitions"}),
    );
    assert_eq!(value["items"].as_array().unwrap().len(), 0, "{value}");
    assert_eq!(value["matched"], 2, "{value}");
    assert_eq!(value["total"], 0, "{value}");
    assert_eq!(value["complete"], true, "{value}");
}
