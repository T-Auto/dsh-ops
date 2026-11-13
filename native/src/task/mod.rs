//! Independently owned fresh tasks; the public host supplies every launch authority.
#[cfg(all(windows, test))]
mod lifecycle_tests;
#[cfg(windows)]
mod manager;
#[cfg(windows)]
mod protocol;
#[cfg(all(windows, test))]
mod tests;
#[cfg(windows)]
mod worker;
#[cfg(windows)]
pub use manager::Manager;

pub fn capabilities() -> &'static [&'static str] {
    if cfg!(windows) { &["task-v1"] } else { &[] }
}

#[cfg(not(windows))]
pub struct Manager;
#[cfg(not(windows))]
impl Manager {
    pub fn new(
        _: std::sync::Arc<dyn Fn(serde_json::Value) -> std::io::Result<()> + Send + Sync>,
        _: impl Fn() + Send + Sync + 'static,
    ) -> std::io::Result<Self> {
        Ok(Self)
    }
    pub fn contains(&self, _: &str) -> bool {
        false
    }
    pub fn reap(&mut self) -> std::io::Result<()> {
        Ok(())
    }
    pub fn cancel(&self, _: &str) -> std::io::Result<()> {
        Ok(())
    }
    pub fn handle(&mut self, _: &serde_json::Value) -> std::io::Result<()> {
        Err(ops_process::shell::unsupported())
    }
    pub fn shutdown(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
