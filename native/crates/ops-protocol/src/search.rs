//! Search reports never attach a full total to an incomplete traversal.
use serde::{Serialize, Serializer, ser::SerializeMap};
use std::collections::BTreeMap;

pub enum SearchCoverage {
    Complete { matched_total: usize },
    Incomplete,
}
impl Serialize for SearchCoverage {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("scanComplete", &matches!(self, Self::Complete { .. }))?;
        if let Self::Complete { matched_total } = self {
            map.serialize_entry("matchedTotal", matched_total)?;
        }
        map.end()
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TruncatedBy {
    ScanBudget,
    OutputBudget,
    Time,
    RowLimit,
    None,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchExecutionReport {
    #[serde(flatten)]
    pub coverage: SearchCoverage,
    pub page_complete: bool,
    pub scanned_files: usize,
    pub skipped_files: usize,
    pub skip_reasons: BTreeMap<String, usize>,
    pub matched_observed: usize,
    pub truncated_by: TruncatedBy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation: Option<String>,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incomplete_coverage_cannot_serialize_a_full_total() {
        let incomplete = serde_json::to_value(SearchCoverage::Incomplete).unwrap();
        assert_eq!(incomplete["scanComplete"], false);
        assert!(incomplete.get("matchedTotal").is_none());
        let complete = serde_json::to_value(SearchCoverage::Complete { matched_total: 7 }).unwrap();
        assert_eq!(complete["scanComplete"], true);
        assert_eq!(complete["matchedTotal"], 7);
    }
}
