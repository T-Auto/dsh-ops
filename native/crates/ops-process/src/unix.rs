use std::{
    io,
    os::{
        fd::{FromRawFd, OwnedFd},
        unix::net::UnixStream,
    },
};
pub type Pipe = UnixStream;

pub fn shutdown(pipe: &Pipe) -> io::Result<()> {
    // XNU's SHUT_RDWR can stop at an already-closed read half and never stop
    // writes. Always attempt each direction, including after a peer half-close.
    let closed = |result: io::Result<()>| match result {
        Err(error) if error.kind() == io::ErrorKind::NotConnected => Ok(()),
        result => result,
    };
    let write = closed(pipe.shutdown(std::net::Shutdown::Write));
    let read = closed(pipe.shutdown(std::net::Shutdown::Read));
    write.and(read)
}

#[cfg(test)]
pub fn test_pair() -> io::Result<(Pipe, Pipe)> {
    UnixStream::pair()
}

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
