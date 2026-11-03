//! Executable constraint: the crate's only unsafe lives in `sys` and `links`.

use std::collections::BTreeMap;

#[test]
fn unsafe_is_confined_to_the_sys_and_links_modules() {
    let sources: [(&str, &str); 14] = [
        ("mod.rs", include_str!("mod.rs")),
        ("sys.rs", include_str!("sys.rs")),
        ("links.rs", include_str!("links.rs")),
        ("enum_data.rs", include_str!("enum_data.rs")),
        ("journal.rs", include_str!("journal.rs")),
        ("error.rs", include_str!("error.rs")),
        ("fixtures.rs", include_str!("fixtures.rs")),
        ("volume_path.rs", include_str!("volume_path.rs")),
        ("enum_tests.rs", include_str!("enum_tests.rs")),
        ("journal_tests.rs", include_str!("journal_tests.rs")),
        ("sys_tests.rs", include_str!("sys_tests.rs")),
        ("error_tests.rs", include_str!("error_tests.rs")),
        ("volume_path_tests.rs", include_str!("volume_path_tests.rs")),
        (
            "unsafe_guard_tests.rs",
            include_str!("unsafe_guard_tests.rs"),
        ),
    ];
    // The needles are assembled from fragments: written literally, this test
    // would find its own source (it contains the very words it searches for).
    let word = ["uns", "afe"].concat();
    let block = format!("{word} {{");
    let function = format!("{word} fn");
    let mut by_file: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (name, source) in sources {
        let found: Vec<&str> = source
            .lines()
            .filter(|line| {
                let text = line.trim_start();
                if text.starts_with("//") || text.starts_with("/*") || text.starts_with('*') {
                    return false;
                }
                text.contains(block.as_str()) || text.contains(function.as_str())
            })
            .collect();
        by_file.insert(name, found);
    }
    for (name, found) in &by_file {
        if *name == "sys.rs" || *name == "links.rs" {
            assert!(
                !found.is_empty(),
                "{name} is an allowed unsafe island and should contain its raw calls"
            );
        } else {
            assert!(
                found.is_empty(),
                "{name} has unsafe code outside the sys/links islands: {found:?}"
            );
        }
    }
}
