use super::{
    manager::{Data, Phase, Request, State, cancellation, finish},
    protocol,
};
use ops_process::shell::{Range, Retention};
use serde_json::{Value, json};
use std::{
    io,
    sync::{Arc, MutexGuard, atomic::Ordering},
    thread,
    time::{Duration, Instant},
};

pub(super) fn run(state: Arc<State>) -> io::Result<()> {
    loop {
        let request = {
            let mut queue = state.queue.lock().unwrap();
            while queue.is_empty() && !state.closing.load(Ordering::Acquire) {
                queue = state.wake.wait(queue).unwrap();
            }
            if state.closing.load(Ordering::Acquire) {
                return Ok(());
            }
            queue.pop_front().unwrap()
        };
        if let Err(error) = execute(&state, &request) {
            (state.fatal)();
            return Err(error);
        }
    }
}
fn cancelled(state: &State, request: &Request) -> bool {
    interrupted(state, request) || request.owner.data.lock().unwrap().closed
}
fn interrupted(state: &State, request: &Request) -> bool {
    state.closing.load(Ordering::Acquire)
        || request.cancelled.load(Ordering::Acquire)
        || request
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
}
fn cancelled_before_launch(state: &State, request: &Request) -> io::Result<()> {
    let (code, message) = cancellation(request);
    finish(
        state,
        request,
        "cancelled",
        None,
        true,
        Some((code, message.into())),
    )
}
fn admission(state: &State, request: &Request) -> io::Result<Option<Value>> {
    let mut data = request.data.lock().unwrap();
    {
        // Seal versus admission publication uses one owner lock. The bounded
        // enqueue cannot wait for physical transport I/O while holding it.
        let owner = request.owner.data.lock().unwrap();
        if owner.closed || interrupted(state, request) {
            return Ok(None);
        }
        data.phase = Phase::Admitting;
        (state.output)(json!({"type":"task.admit","requestId":request.id}))?;
    }
    loop {
        if cancelled(state, request) {
            return Ok(None);
        }
        if let Some(reply) = data.admission.take() {
            return Ok(Some(reply));
        }
        data = wait(request, data);
    }
}
fn wait<'a>(request: &'a Request, data: MutexGuard<'a, Data>) -> MutexGuard<'a, Data> {
    if let Some(deadline) = request.deadline {
        request
            .wake
            .wait_timeout(data, deadline.saturating_duration_since(Instant::now()))
            .unwrap()
            .0
    } else {
        request.wake.wait(data).unwrap()
    }
}
fn execute(state: &State, request: &Request) -> io::Result<()> {
    if cancelled(state, request) {
        return cancelled_before_launch(state, request);
    }
    let Some(reply) = admission(state, request)? else {
        return cancelled_before_launch(state, request);
    };
    if reply["decision"] == "reject" {
        return finish(
            state,
            request,
            "rejected",
            None,
            true,
            Some((
                reply["error"]["code"].as_str().unwrap(),
                reply["error"]["message"].as_str().unwrap().into(),
            )),
        );
    }
    let launch = protocol::launch(&reply["launch"])?;
    let mut range = match Range::new() {
        Ok(range) => range,
        Err(error) => {
            return finish(
                state,
                request,
                "failed",
                None,
                true,
                Some(("EXECUTOR_UNAVAILABLE", error.to_string())),
            );
        }
    };
    if let Some(store) = state.spill.get()
        && let Err(error) = range.enable_spill(store.clone())
    {
        return finish(
            state,
            request,
            "failed",
            None,
            true,
            Some(("EXECUTOR_UNAVAILABLE", error.to_string())),
        );
    }
    {
        let mut data = request.data.lock().unwrap();
        if cancelled(state, request) {
            drop(data);
            return cancelled_before_launch(state, request);
        }
        data.phase = Phase::Launching;
        // Launch arguments contain the user's command. An absent start receipt
        // after accepted launch traffic is never evidence that no effects ran.
        data.effects_possible = true;
    }
    if let Err(error) = range.spawn_with_retention(launch, Retention::Tail) {
        return settle_failure(state, request, range, error, "TASK_LAUNCH_FAILED");
    }
    {
        let mut data = request.data.lock().unwrap();
        data.views = range.output_views();
        data.phase = Phase::Running;
    }
    if let Err(error) = (state.output)(json!({"type":"task.started","requestId":request.id})) {
        return settle_failure(state, request, range, error, "TRANSPORT_UNAVAILABLE");
    }
    match monitor(state, request, &mut range) {
        Ok(code) => {
            let error = range
                .captures_until(Instant::now() + Duration::from_secs(5))
                .err();
            if let Some(error) = error {
                if range.cleanup_unconfirmed() {
                    return poison(
                        state,
                        request,
                        range,
                        error.to_string(),
                        "OUTPUT_INCOMPLETE",
                    );
                }
                return finish(
                    state,
                    request,
                    "failed",
                    Some(code),
                    true,
                    Some(("OUTPUT_INCOMPLETE", error.to_string())),
                );
            }
            if cancelled(state, request) {
                let (code_name, message) = cancellation(request);
                finish(
                    state,
                    request,
                    "cancelled",
                    Some(code),
                    true,
                    Some((code_name, message.into())),
                )
            } else {
                finish(state, request, "completed", Some(code), true, None)
            }
        }
        Err(error) => settle_failure(state, request, range, error, "TASK_FAILED"),
    }
}
fn monitor(state: &State, request: &Request, range: &mut Range) -> io::Result<u32> {
    loop {
        if cancelled(state, request) {
            request.data.lock().unwrap().phase = Phase::Cleaning;
            stop(state, request, range)?;
            return range.exit_code();
        }
        let root = range.root_exit()?;
        if range.active_processes()? == 0 {
            request.data.lock().unwrap().phase = Phase::Cleaning;
            range.wait_empty(Instant::now() + Duration::from_secs(5))?;
            return range.exit_code();
        }
        if root.is_some() {
            let fresh = {
                let mut data = request.data.lock().unwrap();
                if data.job {
                    false
                } else {
                    data.phase = Phase::Cleaning;
                    true
                }
            };
            if fresh {
                // Promotion and ordinary root-exit cleanup use the same mutex.
                // A registry record alone never promotes surviving descendants.
                let until = Instant::now() + request.grace;
                while range.active_processes()? != 0
                    && Instant::now() < until
                    && !cancelled(state, request)
                {
                    thread::sleep(Duration::from_millis(5));
                }
                range.terminate(Instant::now() + Duration::from_secs(5))?;
                return range.exit_code();
            }
        }
        thread::sleep(Duration::from_millis(5));
    }
}
fn stop(state: &State, request: &Request, range: &mut Range) -> io::Result<()> {
    let until = Instant::now() + request.grace;
    if range.root_exit()?.is_none() {
        let attempt_until = until.min(Instant::now() + Duration::from_secs(2));
        // A soft attempt is optional evidence, never a replacement for confirmed
        // hard-stop ownership. Global/provider shutdown may end the grace early.
        let _ = range.interrupt(&std::env::current_exe()?, attempt_until);
    }
    while range.active_processes()? != 0
        && Instant::now() < until
        && !state.closing.load(Ordering::Acquire)
        && !request.owner.data.lock().unwrap().closed
    {
        thread::sleep(Duration::from_millis(5));
    }
    range.terminate(Instant::now() + Duration::from_secs(5))
}
fn settle_failure(
    state: &State,
    request: &Request,
    mut range: Range,
    error: io::Error,
    code: &'static str,
) -> io::Result<()> {
    {
        let mut data = request.data.lock().unwrap();
        data.phase = Phase::Cleaning;
        if data.views.is_none() {
            data.views = range.output_views();
        }
    }
    let mut message = error.to_string();
    let cleanup = range.terminate(Instant::now() + Duration::from_secs(5));
    if let Err(cleanup_error) = cleanup {
        message.push_str(&format!("; cleanup: {cleanup_error}"));
        return poison(state, request, range, message, code);
    }
    if let Err(capture) = range.captures_until(Instant::now() + Duration::from_secs(5)) {
        message.push_str(&format!("; output: {capture}"));
    }
    if range.cleanup_unconfirmed() {
        return poison(state, request, range, message, "OUTPUT_INCOMPLETE");
    }
    let (status, code) = if cancelled(state, request) {
        let (code, reason) = cancellation(request);
        message = format!("{reason}; {message}");
        ("cancelled", code)
    } else {
        ("failed", code)
    };
    finish(
        state,
        request,
        status,
        range.exit_code().ok(),
        true,
        Some((code, message)),
    )
}
fn poison(
    state: &State,
    request: &Request,
    range: Range,
    message: String,
    code: &str,
) -> io::Result<()> {
    request.data.lock().unwrap().poison = Some(range);
    // Seal before terminal publication: an unconfirmed owner cannot admit another
    // queued request while the host observes its failure and retires the kernel.
    {
        let mut owner = request.owner.data.lock().unwrap();
        owner.closed = true;
        owner.unconfirmed = true;
    }
    let result = finish(state, request, "failed", None, false, Some((code, message)));
    (state.fatal)();
    result
}

#[cfg(test)]
#[path = "spill_tests.rs"]
mod spill_tests;
