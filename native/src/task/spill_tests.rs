//! Coordinator ordering only: the retained real range is empty, with no child or injected OS I/O.
use super::poison;
use crate::task::manager::{Data, Owner, OwnerData, Phase, Request, State};
use ops_process::shell::Range;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    io,
    sync::{
        Arc, Condvar, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

#[derive(Debug)]
struct Observation {
    event: &'static str,
    frame: Option<Value>,
    sealed: bool,
    unconfirmed: bool,
    retained_range: bool,
    completed: bool,
    fatal_calls: usize,
}

fn observe(
    event: &'static str,
    frame: Option<Value>,
    request: &Request,
    fatal_calls: &AtomicUsize,
) -> Observation {
    // Match the coordinator's request -> owner lock order while observing publication.
    let data = request.data.lock().unwrap();
    let owner = request.owner.data.lock().unwrap();
    Observation {
        event,
        frame,
        sealed: owner.closed,
        unconfirmed: owner.unconfirmed,
        retained_range: data.poison.is_some(),
        completed: data.phase == Phase::Completed,
        fatal_calls: fatal_calls.load(Ordering::Acquire),
    }
}

fn check_poison(publication_fails: bool) -> io::Result<()> {
    let owner = Arc::new(Owner {
        key: "poison-owner".into(),
        data: Mutex::new(OwnerData {
            pending: HashSet::from(["poison-request".into()]),
            ..OwnerData::default()
        }),
    });
    let request = Arc::new(Request {
        id: "poison-request".into(),
        owner: owner.clone(),
        deadline: None,
        grace: Duration::ZERO,
        cancelled: AtomicBool::new(false),
        data: Mutex::new(Data {
            phase: Phase::Cleaning,
            effects_possible: true,
            ..Data::default()
        }),
        wake: Condvar::new(),
    });
    let observations = Arc::new(Mutex::new(Vec::new()));
    let fatal_calls = Arc::new(AtomicUsize::new(0));
    let output_request = request.clone();
    let output_observations = observations.clone();
    let output_fatal_calls = fatal_calls.clone();
    let fatal_request = request.clone();
    let fatal_observations = observations.clone();
    let fatal_counter = fatal_calls.clone();
    let state = State {
        spill: OnceLock::new(),
        output: Arc::new(move |frame| {
            output_observations.lock().unwrap().push(observe(
                "publication",
                Some(frame),
                &output_request,
                &output_fatal_calls,
            ));
            if publication_fails {
                Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "fixture publication refused",
                ))
            } else {
                Ok(())
            }
        }),
        fatal: Arc::new(move || {
            fatal_counter.fetch_add(1, Ordering::AcqRel);
            fatal_observations.lock().unwrap().push(observe(
                "fatal",
                None,
                &fatal_request,
                &fatal_counter,
            ));
        }),
        requests: Mutex::new(HashMap::from([(request.id.clone(), request.clone())])),
        owners: Mutex::new(HashMap::from([(owner.key.clone(), owner.clone())])),
        controls: Mutex::default(),
        queue: Mutex::default(),
        wake: Condvar::new(),
        closing: AtomicBool::new(false),
    };
    let range = Range::new()?;
    assert_eq!(range.active_processes()?, 0);
    let result = poison(
        &state,
        &request,
        range,
        "fixture capture cleanup is unconfirmed".into(),
        "OUTPUT_INCOMPLETE",
    );
    if publication_fails {
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
    } else {
        result?;
    }
    let observations = observations.lock().unwrap();
    assert_eq!(observations.len(), 2, "{observations:?}");
    assert_eq!(observations[0].event, "publication");
    assert_eq!(observations[0].fatal_calls, 0);
    assert_eq!(observations[1].event, "fatal");
    assert_eq!(observations[1].fatal_calls, 1);
    for observation in observations.iter() {
        assert!(
            observation.sealed,
            "owner must be sealed before {observation:?}"
        );
        assert!(
            observation.unconfirmed,
            "cleanup cannot be claimed at {observation:?}"
        );
        assert!(
            observation.retained_range,
            "range ownership must survive {observation:?}"
        );
        assert!(
            observation.completed,
            "terminal state must precede {observation:?}"
        );
    }
    let terminal = observations[0].frame.as_ref().unwrap();
    assert_eq!(terminal["type"], "task.completed");
    assert_eq!(terminal["requestId"], request.id);
    assert_eq!(terminal["status"], "failed");
    assert_eq!(terminal["effectState"], "unknown");
    assert_eq!(terminal["cleanupConfirmed"], false);
    assert_eq!(terminal["error"]["code"], "OUTPUT_INCOMPLETE");
    assert_eq!(terminal["stdoutTotal"], 0);
    assert_eq!(terminal["stderrTotal"], 0);
    assert_eq!(
        request.data.lock().unwrap().terminal.as_ref(),
        Some(terminal)
    );
    assert!(owner.data.lock().unwrap().pending.is_empty());
    assert!(state.owners.lock().unwrap().contains_key(&owner.key));
    assert!(state.requests.lock().unwrap().contains_key(&request.id));
    let retained = request.data.lock().unwrap().poison.take().unwrap();
    assert_eq!(retained.active_processes()?, 0);
    drop(retained);
    Ok(())
}

#[test]
fn poison_seals_owner_and_retains_range_before_terminal_publication() -> io::Result<()> {
    check_poison(false)
}

#[test]
fn poison_keeps_ownership_and_invokes_fatal_when_publication_fails() -> io::Result<()> {
    check_poison(true)
}
