//! Request-invariant glob segments; matching semantics remain the existing byte-wise contract.
use super::*;
pub struct Patterns<'a> {
    positive: Vec<Vec<&'a str>>,
    negative: Vec<Vec<&'a str>>,
}
impl<'a> Patterns<'a> {
    pub fn new(patterns: &'a [String]) -> Self {
        let mut result = Self {
            positive: Vec::new(),
            negative: Vec::new(),
        };
        for pattern in patterns {
            let (exclude, pattern) = pattern
                .strip_prefix('!')
                .map_or((false, pattern.as_str()), |value| (true, value));
            let segments = pattern.trim_start_matches("./").split('/').collect();
            if exclude {
                result.negative.push(segments);
            } else {
                result.positive.push(segments);
            }
        }
        result
    }
    pub fn matches(&self, root: &Path, file: &Path) -> bool {
        if self.positive.is_empty() && self.negative.is_empty() {
            return true;
        }
        let name = relative_display(root, file);
        let value: Vec<_> = name.split('/').collect();
        (self.positive.is_empty()
            || self
                .positive
                .iter()
                .any(|pattern| glob_segments(pattern, &value)))
            && !self
                .negative
                .iter()
                .any(|pattern| glob_segments(pattern, &value))
    }
}
/// Why a pattern entry can never match a walked file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EntryFault {
    /// The entry names no glob text at all: empty, whitespace, "!" or "./".
    Empty,
    /// A slash-separated segment cannot be a component of a relative path.
    Segment,
}

/// Report the first entry that no walked file can satisfy.
///
/// Patterns::new removes one leading "!" and every leading "./", then splits on
/// "/". relative_display only yields components that are non-empty and are never
/// "." or "..", and the walk refuses links, so an entry that compiles to an
/// empty segment (including the empty entry itself) or to a "."/".." segment can
/// only come back as a silent zero. Validation mirrors that compilation exactly;
/// it deliberately does not reject entries that are merely unlikely for policy
/// reasons, such as a hidden or dependency directory.
pub(crate) fn first_invalid(patterns: &[String]) -> Option<(usize, EntryFault)> {
    patterns.iter().enumerate().find_map(|(index, pattern)| {
        // The same two transformations Patterns::new applies before matching.
        let glob = pattern
            .strip_prefix('!')
            .unwrap_or(pattern.as_str())
            .trim_start_matches("./");
        if glob.trim().is_empty() {
            return Some((index, EntryFault::Empty));
        }
        let impossible = glob
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..");
        impossible.then_some((index, EntryFault::Segment))
    })
}

/// Name the offending entry so the caller can point at the array index.
pub(crate) fn invalid_message(field: &str, index: usize, fault: EntryFault) -> String {
    match fault {
        EntryFault::Empty => format!("{field}[{index}] must be a non-empty glob"),
        EntryFault::Segment => {
            format!("{field}[{index}] must not contain an empty, \".\" or \"..\" path segment")
        }
    }
}

#[cfg(test)]
mod entry_tests {
    use super::*;

    /// The rule has to accept every entry the matcher can still satisfy.
    #[test]
    fn only_impossible_entries_are_refused() {
        for valid in [
            "*",
            "**",
            "**/*.md",
            "./**/*.TS",
            "a/**/b",
            "!!literal",
            "!**/*.ts",
            "中/*",
            "a.b",
            "..dots",
        ] {
            assert_eq!(first_invalid(&[valid.to_owned()]), None, "{valid}");
        }
        for (invalid, fault) in [
            ("", EntryFault::Empty),
            ("   ", EntryFault::Empty),
            ("!", EntryFault::Empty),
            ("./", EntryFault::Empty),
            ("././", EntryFault::Empty),
            ("/", EntryFault::Segment),
            ("src/", EntryFault::Segment),
            ("a//b", EntryFault::Segment),
            ("..", EntryFault::Segment),
            ("../**/*.md", EntryFault::Segment),
            (".", EntryFault::Segment),
            ("a/./b", EntryFault::Segment),
            ("!src/", EntryFault::Segment),
        ] {
            assert_eq!(
                first_invalid(&[invalid.to_owned()]),
                Some((0, fault)),
                "{invalid}"
            );
        }
        assert_eq!(
            first_invalid(&["**".to_owned(), "src/".to_owned()]),
            Some((1, EntryFault::Segment))
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn original(patterns: &[String], name: &str) -> bool {
        let matches = |pattern: &str| {
            glob_segments(
                &pattern
                    .trim_start_matches("./")
                    .split('/')
                    .collect::<Vec<_>>(),
                &name.split('/').collect::<Vec<_>>(),
            )
        };
        let positive: Vec<_> = patterns
            .iter()
            .filter(|pattern| !pattern.starts_with('!'))
            .collect();
        (positive.is_empty() || positive.iter().any(|pattern| matches(pattern)))
            && !patterns
                .iter()
                .filter_map(|pattern| pattern.strip_prefix('!'))
                .any(matches)
    }
    #[test]
    fn compiled_patterns_match_original_inclusions_exclusions_and_path_segments() {
        let roots = Path::new("corpus");
        let patterns = [
            "",
            "*",
            "**",
            "**/*.ts",
            "./**/*.TS",
            "a/?",
            "!**/test*",
            "!**/*.ts",
            "a/**/b",
            "!!literal",
            "中/*",
        ];
        let paths = [
            "",
            "a",
            "a/b",
            "a/x/b",
            "a/test.ts",
            "test.TS",
            "dir/test.ts",
            "中/文.ts",
            "!literal",
            "a/😀",
            "a/.ts",
        ];
        for first in patterns {
            for second in patterns {
                let input = vec![first.to_owned(), second.to_owned()];
                let compiled = Patterns::new(&input);
                for name in paths {
                    assert_eq!(
                        compiled.matches(roots, &roots.join(name)),
                        original(&input, name),
                        "{input:?}: {name}"
                    );
                }
            }
        }
        assert!(Patterns::new(&[]).matches(roots, &roots.join("any")));
    }
}
