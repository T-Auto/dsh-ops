//! Kernel-owned shell queues. The host supplies current authority at every head.
#[cfg(windows)]
mod driver;
#[cfg(windows)]
mod manager;
#[cfg(windows)]
mod protocol;
#[cfg(windows)]
mod session;
#[cfg(all(windows, test))]
mod tests;
#[cfg(windows)]
pub use manager::Manager;

pub fn capabilities() -> serde_json::Value {
    if cfg!(windows) {
        serde_json::json!(["shell-v1"])
    } else {
        serde_json::json!([])
    }
}

#[cfg(not(windows))]
pub struct Manager;
#[cfg(not(windows))]
impl Manager {
    pub fn new(
        _: impl Fn(serde_json::Value) -> std::io::Result<()> + Send + Sync + 'static,
        _: impl Fn() + Send + Sync + 'static,
    ) -> std::io::Result<Self> {
        Ok(Self)
    }
    pub fn contains(&self, _: &str) -> bool {
        false
    }
    pub fn output(
        &self,
    ) -> std::sync::Arc<dyn Fn(serde_json::Value) -> std::io::Result<()> + Send + Sync> {
        std::sync::Arc::new(|_| Err(ops_process::shell::unsupported()))
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
