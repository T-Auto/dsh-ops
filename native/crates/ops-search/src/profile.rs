//! Explicit diagnostic timing only: no paths, contents or tool-result fields.
use std::{cell::RefCell, collections::BTreeMap, time::Instant};
use serde_json::json;
pub struct Profile { enabled: bool, stages: RefCell<BTreeMap<&'static str, (u64, u64)>> }
impl Profile {
    pub fn new() -> Self {
        Self { enabled: std::env::var_os("DSH_OPS_PROFILE_SEARCH").is_some_and(|value| value == "1"), stages: RefCell::new(BTreeMap::new()) }
    }
    pub fn start(&self) -> Option<Instant> { self.enabled.then(Instant::now) }
    pub fn record(&self, stage: &'static str, started: Option<Instant>) {
        if let Some(started) = started {
            let elapsed = started.elapsed().as_nanos().min(u64::MAX as u128) as u64;
            let mut stages = self.stages.borrow_mut(); let entry = stages.entry(stage).or_default();
            entry.0 += 1; entry.1 = entry.1.saturating_add(elapsed);
        }
    }
}
impl Drop for Profile {
    fn drop(&mut self) {
        if self.enabled {
            let stages: BTreeMap<_, _> = self.stages.borrow().iter().map(|(name, (calls, nanos))|
                (*name, json!({"calls":calls,"nanos":nanos}))).collect();
            // walkTotal contains the other stages; these timings are not additive host latency.
            eprintln!("dsh-ops-search-profile {}", json!({"version":1,"stages":stages}));
        }
    }
}
