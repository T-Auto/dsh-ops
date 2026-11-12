//! OPS private supervisor entry, linked into the existing provenance-checked worker binary.
#[cfg(windows)]
mod protocol;
#[cfg(windows)]
mod supervisor;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod worker;

pub fn run(parent: u32, nonce: String) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        supervisor::run(parent, nonce)
    }
    #[cfg(not(windows))]
    {
        let _ = (parent, nonce);
        Err(std::io::Error::other(
            "OPS cradle requires Windows Job containment",
        ))
    }
}
