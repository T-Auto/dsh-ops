//! Private cross-platform byte streams for stdio proxy to control-center connections.

use std::path::{Path, PathBuf};
use tokio::io::{AsyncRead, AsyncWrite};

pub(crate) trait LocalStream: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T> LocalStream for T where T: AsyncRead + AsyncWrite + Send + Unpin {}
pub(crate) type BoxedStream = Box<dyn LocalStream>;

/// Address material shared by the proxy and the matching build's control center.
#[derive(Clone, Debug)]
pub(crate) struct LocalEndpoint {
    runtime_directory: PathBuf,
    id: String,
}

impl LocalEndpoint {
    pub(crate) fn new(runtime_directory: PathBuf, id: String) -> Self {
        Self {
            runtime_directory,
            id,
        }
    }

    pub(crate) fn runtime_directory(&self) -> &Path {
        &self.runtime_directory
    }

    pub(crate) fn startup_lock_path(&self) -> PathBuf {
        self.runtime_directory
            .join(format!("{}.startup.lock", self.id))
    }

    pub(crate) fn instance_lock_path(&self) -> PathBuf {
        self.runtime_directory
            .join(format!("{}.instance.lock", self.id))
    }

    #[cfg(unix)]
    fn socket_path(&self) -> PathBuf {
        self.runtime_directory.join(format!("{}.sock", self.id))
    }

    #[cfg(windows)]
    fn pipe_name(&self) -> String {
        format!(r"\\.\pipe\{}", self.id)
    }
}

#[cfg(unix)]
mod platform {
    use super::{BoxedStream, LocalEndpoint};
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::{UnixListener, UnixStream};

    pub(crate) struct Listener {
        inner: UnixListener,
        socket_path: std::path::PathBuf,
    }

    impl Listener {
        pub(crate) fn bind(endpoint: &LocalEndpoint) -> Result<Self, String> {
            let socket_path = endpoint.socket_path();
            if let Err(error) = std::fs::remove_file(&socket_path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                return Err(format!(
                    "Cannot remove a stale control-center socket {}: {error}",
                    crate::paths::display_path(&socket_path)
                ));
            }
            let inner = UnixListener::bind(&socket_path).map_err(|error| {
                format!(
                    "Cannot bind the control-center socket {}: {error}",
                    crate::paths::display_path(&socket_path)
                )
            })?;
            std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
                .map_err(|error| {
                    format!(
                        "Cannot secure the control-center socket {}: {error}",
                        crate::paths::display_path(&socket_path)
                    )
                })?;
            Ok(Self { inner, socket_path })
        }

        pub(crate) async fn accept(&mut self) -> Result<BoxedStream, String> {
            self.inner
                .accept()
                .await
                .map(|(stream, _)| Box::new(stream) as BoxedStream)
                .map_err(|error| format!("Cannot accept a control-center connection: {error}"))
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.socket_path);
        }
    }

    pub(crate) async fn connect(endpoint: &LocalEndpoint) -> Result<BoxedStream, String> {
        UnixStream::connect(endpoint.socket_path())
            .await
            .map(|stream| Box::new(stream) as BoxedStream)
            .map_err(|error| format!("Cannot connect to the FastCtx control center: {error}"))
    }
}

#[cfg(windows)]
mod platform {
    use super::{BoxedStream, LocalEndpoint};
    use tokio::net::windows::named_pipe::{
        ClientOptions, NamedPipeServer, ServerOptions as PipeServerOptions,
    };

    pub(crate) struct Listener {
        endpoint: LocalEndpoint,
        current: Option<NamedPipeServer>,
    }

    impl Listener {
        pub(crate) fn bind(endpoint: &LocalEndpoint) -> Result<Self, String> {
            let current = create_server(endpoint, true)?;
            Ok(Self {
                endpoint: endpoint.clone(),
                current: Some(current),
            })
        }

        pub(crate) async fn accept(&mut self) -> Result<BoxedStream, String> {
            if self.current.is_none() {
                self.current = Some(create_server(&self.endpoint, false)?);
            }
            if let Err(error) = self
                .current
                .as_mut()
                .expect("the named-pipe listener is initialized before accept")
                .connect()
                .await
            {
                self.current = None;
                return Err(format!(
                    "Cannot accept a control-center connection: {error}"
                ));
            }
            let connected = self
                .current
                .take()
                .expect("the connected named-pipe listener remains present");
            // Do not discard an already accepted session if allocating the next pipe instance
            // fails. The following accept retries allocation while live sessions keep running.
            self.current = create_server(&self.endpoint, false).ok();
            Ok(Box::new(connected))
        }
    }

    fn create_server(endpoint: &LocalEndpoint, first: bool) -> Result<NamedPipeServer, String> {
        let descriptor = crate::edit::private_storage::PrivateSecurityDescriptor::new()?;
        let mut attributes = descriptor.security_attributes();
        let mut options = PipeServerOptions::new();
        options.first_pipe_instance(first);
        // SAFETY: attributes and its descriptor stay live for this synchronous CreateNamedPipeW
        // call. Windows copies the descriptor into the new kernel object before returning.
        unsafe {
            options.create_with_security_attributes_raw(
                endpoint.pipe_name(),
                (&mut attributes as *mut windows_sys::Win32::Security::SECURITY_ATTRIBUTES).cast(),
            )
        }
        .map_err(|error| format!("Cannot create the private control-center pipe: {error}"))
    }

    pub(crate) async fn connect(endpoint: &LocalEndpoint) -> Result<BoxedStream, String> {
        ClientOptions::new()
            .open(endpoint.pipe_name())
            .map(|stream| Box::new(stream) as BoxedStream)
            .map_err(|error| format!("Cannot connect to the FastCtx control center: {error}"))
    }
}

#[cfg(not(any(unix, windows)))]
compile_error!("FastCtx control-center IPC requires Unix-domain sockets or Windows named pipes.");

pub(crate) use platform::{Listener, connect};
