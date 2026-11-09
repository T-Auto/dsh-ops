//! Output limits shared by the PDF layers that enforce them, with no cross-layer policy import.
use ops_protocol::{Failure, Result};
use std::time::{Duration, Instant};
/// Decoded bytes accepted for a page's content streams and for the font tables a run charges.
pub const MAX_CONTENT_DECODED: usize = 16 * 1024 * 1024;
/// Fail once the PDF text layer has spent 30 seconds, whichever layer checks next.
pub fn deadline(started: Instant) -> Result<()> {
    if started.elapsed() >= Duration::from_secs(30) {
        return Err(Failure::new(
            "DEADLINE_EXCEEDED",
            "PDF reading reached its 30-second deadline",
        ));
    }
    Ok(())
}
