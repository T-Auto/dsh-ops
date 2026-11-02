//! Request-invariant glob segments; matching semantics remain the existing byte-wise contract.
use super::*;
pub struct Patterns<'a> { positive: Vec<Vec<&'a str>>, negative: Vec<Vec<&'a str>> }
impl<'a> Patterns<'a> {
    pub fn new(patterns: &'a [String]) -> Self {
        let mut result = Self { positive: Vec::new(), negative: Vec::new() };
        for pattern in patterns {
            let (exclude, pattern) = pattern.strip_prefix('!').map_or((false, pattern.as_str()), |value| (true, value));
            let segments = pattern.trim_start_matches("./").split('/').collect();
            if exclude { result.negative.push(segments); } else { result.positive.push(segments); }
        }
        result
    }
    pub fn matches(&self, root: &Path, file: &Path) -> bool {
        if self.positive.is_empty() && self.negative.is_empty() { return true; }
        let name = relative_display(root, file);
        let value: Vec<_> = name.split('/').collect();
        (self.positive.is_empty() || self.positive.iter().any(|pattern| glob_segments(pattern, &value)))
            && !self.negative.iter().any(|pattern| glob_segments(pattern, &value))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn original(patterns: &[String], name: &str) -> bool {
        let matches = |pattern: &str| glob_segments(&pattern.trim_start_matches("./").split('/').collect::<Vec<_>>(), &name.split('/').collect::<Vec<_>>());
        let positive: Vec<_> = patterns.iter().filter(|pattern| !pattern.starts_with('!')).collect();
        (positive.is_empty() || positive.iter().any(|pattern| matches(pattern)))
            && !patterns.iter().filter_map(|pattern| pattern.strip_prefix('!')).any(matches)
    }
    #[test]
    fn compiled_patterns_match_original_inclusions_exclusions_and_path_segments() {
        let roots = Path::new("corpus");
        let patterns = ["", "*", "**", "**/*.ts", "./**/*.TS", "a/?", "!**/test*", "!**/*.ts", "a/**/b", "!!literal", "中/*"];
        let paths = ["", "a", "a/b", "a/x/b", "a/test.ts", "test.TS", "dir/test.ts", "中/文.ts", "!literal", "a/😀", "a/.ts"];
        for first in patterns { for second in patterns {
            let input = vec![first.to_owned(), second.to_owned()]; let compiled = Patterns::new(&input);
            for name in paths { assert_eq!(compiled.matches(roots, &roots.join(name)), original(&input, name), "{input:?}: {name}"); }
        } }
        assert!(Patterns::new(&[]).matches(roots, &roots.join("any")));
    }
}
