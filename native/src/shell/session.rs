//! One FIFO worker owns a session's shell and joins it before reporting state loss.
use super::{
    driver::{Call, Driver},
    manager::{Control, Request, Session, State, cancellation, finish},
    protocol,
};
use serde_json::{Value, json};
use std::{
    io,
    sync::{Arc, atomic::Ordering, mpsc},
    time::{Duration, Instant},
};

struct Worker {
    state: Arc<State>,
    session: Arc<Session>,
    driver: Option<Driver>,
    live: bool,
}
struct Stopped {
    confirmed: bool,
    error: Option<String>,
}

pub(super) fn run(state: Arc<State>, session: Arc<Session>) -> io::Result<()> {
    let mut worker = Worker {
        state,
        session,
        driver: None,
        live: false,
    };
    let result = worker.run();
    // Every exit, including a failed control write, retains ownership until join.
    let stopped = worker.stop();
    result.and(
        stopped
            .error
            .map_or(Ok(()), |error| Err(io::Error::other(error))),
    )
}

impl Worker {
    fn run(&mut self) -> io::Result<()> {
        loop {
            let mut queue = self.session.queue.lock().unwrap();
            while queue.controls.is_empty()
                && queue.requests.is_empty()
                && !self.state.closing.load(Ordering::Acquire)
            {
                queue = self.session.wake.wait(queue).unwrap();
            }
            if self.state.closing.load(Ordering::Acquire) {
                return Ok(());
            }
            if !queue.controls.is_empty() {
                let controls = std::mem::take(&mut queue.controls);
                drop(queue);
                if self.controls(controls)? {
                    return Ok(());
                }
                continue;
            }
            let request = queue.requests.pop_front().unwrap();
            queue.active = Some(request.clone());
            drop(queue);
            let result = self.execute(&request);
            self.session.queue.lock().unwrap().active = None;
            result?;
            if self.driver.as_ref().is_some_and(|driver| !driver.stopped()) && !self.live {
                // Failed cleanup poisons this owner. Its queued calls cannot acquire
                // another range under the same identity, even if Drop later succeeds.
                return self.poison();
            }
        }
    }

    fn stop(&mut self) -> Stopped {
        self.live = false;
        let Some(driver) = &mut self.driver else {
            return Stopped {
                confirmed: true,
                error: None,
            };
        };
        let error = driver.stop().err().map(|error| error.to_string());
        let confirmed = driver.stopped();
        if confirmed {
            self.driver = None;
        }
        Stopped { confirmed, error }
    }

    fn controls(&mut self, controls: Vec<Control>) -> io::Result<bool> {
        let stopped = self.stop();
        let close = controls.iter().any(|control| control.close);
        let terminal = close || !stopped.confirmed;
        if terminal {
            self.close_queue(stopped.confirmed)?;
        }
        for control in controls {
            self.state.controls.lock().unwrap().remove(&control.id);
            let mut response = json!({"type":"shell.closed","requestId":control.id,"cleanupConfirmed":stopped.confirmed});
            if let Some(error) = &stopped.error {
                response["error"] = json!({"code":"SHELL_RESET","message":error});
            }
            (self.state.output)(response)?;
        }
        if terminal {
            // Controls may have arrived while the range was stopping. Publish
            // their acknowledgements too, before retiring this worker.
            self.ack_remaining(stopped.confirmed)?;
            if stopped.confirmed {
                self.remove_owner();
            }
        }
        Ok(terminal)
    }

    fn close_queue(&self, cleanup: bool) -> io::Result<()> {
        let pending = {
            let mut queue = self.session.queue.lock().unwrap();
            queue.closing = true;
            queue.terminal_cleanup = Some(cleanup);
            std::mem::take(&mut queue.requests)
        };
        for request in pending {
            request.cancelled.store(true, Ordering::Release);
            finish(
                &self.state,
                &request,
                "cancelled",
                None,
                true,
                cleanup,
                Some((
                    "OWNER_CLOSED",
                    "Shell owner closed before this command started".into(),
                )),
            )?;
        }
        Ok(())
    }

    fn ack_remaining(&self, cleanup: bool) -> io::Result<()> {
        let controls = std::mem::take(&mut self.session.queue.lock().unwrap().controls);
        for control in controls {
            self.state.controls.lock().unwrap().remove(&control.id);
            let mut response =
                json!({"type":"shell.closed","requestId":control.id,"cleanupConfirmed":cleanup});
            if !cleanup {
                response["error"] = json!({"code":"CLEANUP_UNKNOWN","message":"Shell range cleanup was not confirmed"});
            }
            (self.state.output)(response)?;
        }
        Ok(())
    }

    fn remove_owner(&self) {
        let mut sessions = self.state.sessions.lock().unwrap();
        if sessions
            .get(&self.session.key)
            .is_some_and(|owner| Arc::ptr_eq(owner, &self.session))
        {
            sessions.remove(&self.session.key);
        }
    }

    fn poison(&self) -> io::Result<()> {
        self.close_queue(false)?;
        self.ack_remaining(false)
    }

    fn admission(&self, request: &Request) -> io::Result<Option<Value>> {
        {
            let mut data = request.data.lock().unwrap();
            data.awaiting = true;
            data.has_shell = self.live;
        }
        let mut frame = json!({"type":"shell.admit","requestId":request.id,"hasShell":self.live});
        if !self.live {
            frame["bootstrap"] = self.driver.as_ref().unwrap().bootstrap();
        }
        (self.state.output)(frame)?;
        let mut data = request.data.lock().unwrap();
        loop {
            if request.cancelled.load(Ordering::Acquire)
                || self.state.closing.load(Ordering::Acquire)
                || Instant::now() >= request.deadline
            {
                data.awaiting = false;
                return Ok(None);
            }
            if let Some(reply) = data.admission.take() {
                data.awaiting = false;
                return Ok(Some(reply));
            }
            let remaining = request.deadline.saturating_duration_since(Instant::now());
            data = request.wake.wait_timeout(data, remaining).unwrap().0;
        }
    }

    fn execute(&mut self, request: &Request) -> io::Result<()> {
        loop {
            if request.cancelled.load(Ordering::Acquire) || Instant::now() >= request.deadline {
                return self.failure(
                    request,
                    None,
                    io::Error::new(io::ErrorKind::Interrupted, "request cancelled"),
                    "SHELL_RESET",
                );
            }
            if self.live {
                if let Err(error) = self.driver.as_ref().unwrap().check_live() {
                    return self.failure(request, None, error, "SHELL_RESET");
                }
            } else if self.driver.is_none() {
                match Driver::prepare() {
                    Ok(driver) => self.driver = Some(driver),
                    Err(error) => {
                        return self.failure(request, None, error, "EXECUTOR_UNAVAILABLE");
                    }
                }
            }
            let Some(admission) = self.admission(request)? else {
                return self.failure(
                    request,
                    None,
                    io::Error::new(
                        io::ErrorKind::Interrupted,
                        "request cancelled during admission",
                    ),
                    "SHELL_RESET",
                );
            };
            match admission["decision"].as_str().unwrap() {
                "retire" => {
                    let stopped = self.stop();
                    if let Some(error) = stopped.error {
                        return finish(
                            &self.state,
                            request,
                            "failed",
                            None,
                            true,
                            stopped.confirmed,
                            Some(("SHELL_RESET", error)),
                        );
                    }
                    // This is the same unstarted request: host rechecks current
                    // authority against the newly prepared bootstrap endpoints.
                    continue;
                }
                "reject" => {
                    let mut cleanup = true;
                    if !self.live {
                        cleanup = self.stop().confirmed;
                    }
                    return finish(
                        &self.state,
                        request,
                        "rejected",
                        None,
                        !self.live,
                        cleanup,
                        Some((
                            admission["error"]["code"].as_str().unwrap(),
                            admission["error"]["message"].as_str().unwrap().into(),
                        )),
                    );
                }
                "launch" => {
                    let launch = protocol::launch(&admission["launch"])?;
                    if let Err(error) = self.driver.as_mut().unwrap().launch(
                        launch,
                        &request.cancelled,
                        request.deadline,
                    ) {
                        return self.failure(request, None, error, "SHELL_LAUNCH_FAILED");
                    }
                    self.live = true;
                }
                "reuse" => {}
                _ => unreachable!("admission reply was validated on the reader"),
            }
            let close_after = admission["closeAfter"].as_bool().unwrap_or(false);
            return self.command(request, admission["commandCwd"].as_str(), close_after);
        }
    }

    fn command(
        &mut self,
        request: &Request,
        cwd: Option<&str>,
        close_after: bool,
    ) -> io::Result<()> {
        let mut call =
            match self
                .driver
                .as_ref()
                .unwrap()
                .call(&request.id, request.caps[0], request.caps[1])
            {
                Ok(call) => call,
                Err(error) => return self.failure(request, None, error, "SHELL_CAPTURE_FAILED"),
            };
        request.data.lock().unwrap().views = Some(call.views());
        if request.cancelled.load(Ordering::Acquire) || Instant::now() >= request.deadline {
            return self.failure(
                request,
                Some(&mut call),
                io::Error::new(
                    io::ErrorKind::Interrupted,
                    "request cancelled before execution",
                ),
                "SHELL_RESET",
            );
        }
        if let Err(error) = self.started(request) {
            return self.failure(request, Some(&mut call), error, "SHELL_RESET");
        }
        {
            let mut data = request.data.lock().unwrap();
            if request.cancelled.load(Ordering::Acquire) || Instant::now() >= request.deadline {
                drop(data);
                return self.failure(
                    request,
                    Some(&mut call),
                    io::Error::new(
                        io::ErrorKind::Interrupted,
                        "request cancelled before command bytes",
                    ),
                    "SHELL_RESET",
                );
            }
            data.started = true;
        }
        match self.driver.as_mut().unwrap().run(
            &mut call,
            &request.command,
            cwd,
            request.deadline,
            &request.cancelled,
        ) {
            Ok(code) => {
                if close_after {
                    let stopped = self.stop();
                    if let Some(error) = stopped.error {
                        return finish(
                            &self.state,
                            request,
                            "failed",
                            Some(code),
                            true,
                            stopped.confirmed,
                            Some(("SHELL_RESET", error)),
                        );
                    }
                }
                finish(
                    &self.state,
                    request,
                    "completed",
                    Some(code),
                    close_after,
                    true,
                    None,
                )
            }
            Err(error) => self.failure(request, Some(&mut call), error, "SHELL_RESET"),
        }
    }

    fn started(&self, request: &Request) -> io::Result<()> {
        let receipt = (self.state.started)(json!({"type":"shell.started","requestId":request.id}))?;
        loop {
            // Physical output may stay blocked while the peer keeps input open.
            // Request cancellation and owner close must still stop this shell.
            if request.cancelled.load(Ordering::Acquire)
                || self.state.closing.load(Ordering::Acquire)
            {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "request cancelled while waiting to publish start",
                ));
            }
            let remaining = request.deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "request deadline before start publication",
                ));
            }
            match receipt.recv_timeout(remaining.min(Duration::from_millis(10))) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(io::Error::other("shell output writer stopped before start"));
                }
            }
        }
    }

    fn failure(
        &mut self,
        request: &Request,
        call: Option<&mut Call>,
        failure: io::Error,
        code: &'static str,
    ) -> io::Result<()> {
        let stopped = self.stop();
        let drain = call.and_then(|call| call.drain(Instant::now() + Duration::from_secs(5)).err());
        let cancelled =
            request.cancelled.load(Ordering::Acquire) || Instant::now() >= request.deadline;
        let (code, mut message) = if cancelled {
            let (code, message) = cancellation(request);
            (code, message.to_owned())
        } else {
            (code, failure.to_string())
        };
        if let Some(error) = stopped.error {
            message.push_str(&format!("; cleanup: {error}"));
        }
        if let Some(error) = drain {
            message.push_str(&format!("; output: {error}"));
        }
        finish(
            &self.state,
            request,
            if cancelled { "cancelled" } else { "failed" },
            None,
            true,
            stopped.confirmed,
            Some((code, message)),
        )
    }
}
