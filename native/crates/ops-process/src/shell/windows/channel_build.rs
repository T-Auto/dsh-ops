use super::*;

impl Channel {
    pub(in crate::shell::windows) fn new(job: Arc<Job>, cap: usize) -> io::Result<Self> {
        Self::framed(job, cap, None)
    }
    pub(in crate::shell::windows) fn framed(
        job: Arc<Job>,
        cap: usize,
        prefix: Option<Prefix>,
    ) -> io::Result<Self> {
        Self::create(
            job,
            cap,
            prefix,
            None,
            #[cfg(test)]
            None,
        )
    }
    pub(in crate::shell::windows) fn spilling(
        job: Arc<Job>,
        cap: usize,
        prefix: &[u8],
        store: SpillStore,
        stream: &'static str,
    ) -> io::Result<Self> {
        if !matches!(stream, "stdout" | "stderr") {
            return Err(io::Error::other("invalid output stream"));
        }
        Self::create(
            job,
            cap,
            Some(Prefix {
                bytes: prefix.to_vec(),
                duplex: false,
            }),
            Some(Spilling {
                view: CaptureView::new(cap, Retention::Prefix)?,
                store,
                stream,
                busy: Arc::new(AtomicBool::new(false)),
            }),
            #[cfg(test)]
            None,
        )
    }
    pub(in crate::shell::windows) fn pooled(
        lease: super::super::channel_pool::Lease,
        cap: usize,
        prefix: &[u8],
        spill: Option<(SpillStore, &'static str)>,
    ) -> io::Result<Self> {
        let spilling = if let Some((store, stream)) = spill {
            if !matches!(stream, "stdout" | "stderr") {
                return Err(io::Error::other("invalid output stream"));
            }
            Some(Spilling {
                view: CaptureView::new(cap, Retention::Prefix)?,
                store,
                stream,
                busy: Arc::new(AtomicBool::new(false)),
            })
        } else {
            None
        };
        Self::build(
            lease.job(),
            cap,
            Some(Prefix {
                bytes: prefix.to_vec(),
                duplex: false,
            }),
            spilling,
            Some(lease),
            #[cfg(test)]
            None,
        )
    }
    pub(super) fn create(
        job: Arc<Job>,
        cap: usize,
        prefix: Option<Prefix>,
        spilling: Option<Spilling>,
        #[cfg(test)] gate: Option<ConnectGate>,
    ) -> io::Result<Self> {
        Self::build(
            job,
            cap,
            prefix,
            spilling,
            None,
            #[cfg(test)]
            gate,
        )
    }
    fn build(
        job: Arc<Job>,
        cap: usize,
        prefix: Option<Prefix>,
        spilling: Option<Spilling>,
        pool: Option<super::super::channel_pool::Lease>,
        #[cfg(test)] gate: Option<ConnectGate>,
    ) -> io::Result<Self> {
        budget(cap)?;
        if prefix
            .as_ref()
            .is_some_and(|p| p.bytes.is_empty() || p.bytes.len() > 256)
        {
            return Err(io::Error::other("channel prefix must be 1..256 bytes"));
        }
        let (name, handles) = if let Some(pool) = &pool {
            (pool.name(), pool.handles())
        } else {
            let name = security::private_name()?;
            let descriptor = security::Security::new()?;
            let attributes = descriptor.attributes();
            let mut handles = Vec::with_capacity(4);
            for index in 0..4 {
                let flags = PIPE_ACCESS_DUPLEX
                    | FILE_FLAG_OVERLAPPED
                    | if index == 0 {
                        FILE_FLAG_FIRST_PIPE_INSTANCE
                    } else {
                        0
                    };
                handles.push(Arc::new(owned(unsafe {
                    CreateNamedPipeW(
                        name.as_ptr(),
                        flags,
                        PIPE_REJECT_REMOTE_CLIENTS,
                        4,
                        65536,
                        65536,
                        0,
                        &attributes,
                    )
                })?));
            }
            (OsString::from_wide(&name[..name.len() - 1]), handles)
        };
        let mut channel = Self {
            name,
            stop: Arc::new(AtomicBool::new(false)),
            seal_connects: Arc::new(ConnectSeal::new()?),
            state: Arc::new(Mutex::new(State::default())),
            handles: Vec::new(),
            readers: Vec::new(),
            pool,
            spilling,
            cancellations: Vec::new(),
            poisoned: false,
        };
        for (index, handle) in handles.iter().enumerate() {
            let (armed, ready) = mpsc::sync_channel(1);
            #[cfg(test)]
            let gate = gate.clone();
            let prefix = prefix.clone();
            let cancel = Cancellation::default();
            let output = channel.spilling.as_ref().map(|spilling| ReaderOutput {
                capture: Output::new(
                    spilling.view.clone(),
                    cap,
                    Some(spilling.store.clone()),
                    spilling.stream,
                    cancel.clone(),
                ),
                busy: spilling.busy.clone(),
            });
            channel.cancellations.push(cancel);
            channel.handles.push(Arc::downgrade(handle));
            let (handle, stop, seal, state, job) = (
                handle.clone(),
                channel.stop.clone(),
                channel.seal_connects.clone(),
                channel.state.clone(),
                job.clone(),
            );
            let reusable = channel.pool.is_some();
            let run = move || {
                #[cfg(test)]
                if let Some(gate) = gate {
                    let mut released = gate.0.lock().unwrap();
                    while !*released {
                        released = gate.1.wait(released).unwrap();
                    }
                }
                if let Err(error) = receive(
                    &handle,
                    &job,
                    &state,
                    cap,
                    prefix.as_ref(),
                    Connection {
                        stop: &stop,
                        seal: &seal,
                        armed,
                        output,
                    },
                ) && !stop.load(Ordering::Acquire)
                {
                    state.lock().unwrap().errors.push(error.to_string());
                }
                if reusable && let Err(error) = super::super::channel_pool::disconnect(&handle) {
                    state.lock().unwrap().errors.push(error.to_string());
                }
                state.lock().unwrap().changed();
            };
            let reader = if let Some(pool) = &channel.pool {
                pool.start(index, Box::new(run))?
            } else {
                super::super::channel_pool::Reader::Dedicated(
                    thread::Builder::new()
                        .name("ops-shell-channel".into())
                        .spawn(run)?,
                )
            };
            channel.readers.push(reader);
            // Do not publish a name before ConnectNamedPipe is pending. A fast
            // metadata open+close before that call produces ERROR_NO_DATA.
            ready
                .recv()
                .map_err(|_| io::Error::other("channel connect worker stopped"))??;
        }
        // Dedicated readers own their instances; pooled leases retain disconnected servers.
        drop(handles);
        Ok(channel)
    }
}
