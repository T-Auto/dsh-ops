//! Two read-only preparations overlap; output/capture stay on the caller in request order.
use super::*;
pub(super) const WIDTH: usize = 2;

pub(super) fn load<T: Send>(
    authorized: Vec<(String, Result<()>)>,
    read: &(impl Fn(&str) -> Result<T> + Sync),
) -> Vec<Result<T>> {
    assert!(authorized.len() <= WIDTH);
    if authorized.len() < 2 {
        return authorized
            .into_iter()
            .map(|(path, permitted)| permitted.and_then(|()| read(&path)))
            .collect();
    }
    std::thread::scope(|scope| {
        let pending: Vec<_> = authorized
            .into_iter()
            .map(|(path, permitted)| {
                std::thread::Builder::new()
                    .name("ops-file-read".into())
                    .spawn_scoped(scope, move || permitted.and_then(|()| read(&path)))
                    .map_err(|error| Failure::new("EXECUTOR_UNAVAILABLE", error))
            })
            .collect();
        pending
            .into_iter()
            .map(|started| {
                started.and_then(|handle| {
                    handle.join().map_err(|_| {
                        Failure::new("EXECUTOR_UNAVAILABLE", "File read thread failed")
                    })?
                })
            })
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{Arc, Mutex, mpsc},
        time::Duration,
    };
    #[test]
    fn two_reads_start_before_either_finishes_and_results_keep_request_order() {
        let (started, starts) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let released = Arc::new(Mutex::new(released));
        let worker = std::thread::spawn(move || {
            load(
                vec![("first".into(), Ok(())), ("second".into(), Ok(()))],
                &|path| {
                    started.send(path.to_owned()).unwrap();
                    released
                        .lock()
                        .unwrap()
                        .recv()
                        .map_err(|error| Failure::new("TEST_RELEASE", error))?;
                    Ok(path.to_owned())
                },
            )
        });
        let first = starts.recv_timeout(Duration::from_secs(2));
        let second = starts.recv_timeout(Duration::from_secs(2));
        // Always unblock and join even when the scheduling assertion will fail.
        release.send(()).unwrap();
        release.send(()).unwrap();
        let results = worker.join().unwrap();
        assert!(
            first.is_ok() && second.is_ok(),
            "both read operations must start before release"
        );
        assert_eq!(
            results.into_iter().map(Result::unwrap).collect::<Vec<_>>(),
            ["first", "second"]
        );
    }
    #[test]
    fn refused_paths_are_never_read_and_do_not_discard_sibling_results() {
        let results = load(
            vec![
                (
                    "denied".into(),
                    Err(Failure::new("CREDENTIAL_DENIED", "fixture")),
                ),
                ("allowed".into(), Ok(())),
            ],
            &|path| {
                assert_eq!(path, "allowed");
                Ok(7)
            },
        );
        assert_eq!(results[0].as_ref().unwrap_err().code, "CREDENTIAL_DENIED");
        assert_eq!(*results[1].as_ref().unwrap(), 7);
    }
}
