use std::{
    io,
    os::{
        fd::{FromRawFd, OwnedFd},
        unix::net::UnixStream,
    },
};
pub type Pipe = UnixStream;

pub fn inherited() -> io::Result<Pipe> {
    // SAFETY: fcntl validates the scalar descriptor and transfers a new owned fd.
    let fd = unsafe { libc::fcntl(7, libc::F_DUPFD_CLOEXEC, 0) };
    if fd == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the successful duplication above returned this owned descriptor.
    let stream = UnixStream::from(unsafe { OwnedFd::from_raw_fd(fd) });
    stream.peer_addr()?; // Reject non-socket/unconnected descriptors before consuming fd 7.
    stream.set_nonblocking(false)?;
    // SAFETY: this one-shot startup API consumes the provider-owned original only.
    if unsafe { libc::close(7) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(stream)
}
