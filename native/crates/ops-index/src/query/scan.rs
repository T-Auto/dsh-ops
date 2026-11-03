// Design informed by mustafaahci/goz (MIT).
//! Candidate scan: folded-arena prefilter, chunked parallel verification, and
//! honest totals.
//!
//! The scan has two shapes. When the query matches case-insensitively and has
//! at least one pattern, the longest folded needle is searched across the whole
//! folded arena with memchr's two-way finder; every hit is mapped back to a
//! name id and the name is verified, so a prefilter can only over-select.
//! Otherwise (match-all, or a case-sensitive query, whose raw names are not
//! guaranteed to be one contiguous arena) the scan walks every name ordinal.
//!
//! Parallelism is deliberately boring. Work is split into fixed-size chunks of
//! name ordinals; up to MAX_THREADS scoped threads take every threads-th
//! chunk; the coordinator concatenates chunk results in chunk-index order,
//! never in completion order. Candidate order is therefore a function of the
//! index alone, and a serial scan and a parallel scan produce identical bytes.
//! The crate owns no global pool: threads live for one call and are capped at
//! eight. The index root is stored under the empty name and is skipped before
//! matching: it is structural, never a row.
//!
//! Budget checks happen at chunk boundaries. A deadline or a match cap aborts
//! the scan and surfaces an error; a truncated scan is never returned as if it
//! were complete.

use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::time::Instant;

use crate::ids::{EntryId, NameId, RecordId};
use crate::index::{EntryTable, NameStore};
use crate::query::{Query, QueryBudget, QueryError};

use super::plan::Plan;

/// Read-only view of interned names and the entries that carry them.
///
/// Implementors must keep the folded arena and the name/entry tables immutable
/// for the duration of a query: the query holds borrows across worker threads
/// and rebuilds page rows from the same view.
///
/// The empty name (length zero) is reserved for the index root. The scan skips
/// it before either matching or expansion, so it is neither a row nor a
/// skipped match; a source must not store a real entry under an empty name.
pub trait NameSource {
    /// Folded-name arena: interned folded names laid out back to back, each
    /// followed by one NUL separator. A released name is not a match for any
    /// non-empty needle because the name no longer has entries.
    fn folded_arena(&self) -> &[u8];

    /// Number of interned name ids; ordinals are in 0..name_count().
    fn name_count(&self) -> u32;

    /// Name id at an ordinal in 0..name_count().
    fn name_at(&self, ordinal: u32) -> NameId;

    /// Raw WTF-8 bytes of one interned name.
    fn name_raw(&self, name: NameId) -> &[u8];

    /// Folded bytes of one interned name.
    fn name_folded(&self, name: NameId) -> &[u8];

    /// Name that owns the folded-arena byte at offset, if any.
    ///
    /// Offsets in a NUL separator or in a released region have no owner and
    /// return None.
    fn folded_name_at(&self, offset: usize) -> Option<NameId>;

    /// Visits every live entry carrying this name, in the index's chain order.
    ///
    /// Each entry appears exactly once and the chain is finite; an entry whose
    /// presentable flag is false must not be reported to a caller as a path but
    /// is still yielded here so the scan can count it as skipped.
    fn for_each_name_entry(&self, name: NameId, visit: &mut dyn FnMut(EntryView));

    /// Reads one live entry back by id; None when the id is not live.
    fn entry(&self, entry: EntryId) -> Option<EntryView>;
}

/// The query-relevant fields of one entry, copied out of the index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EntryView {
    /// Table slot of this entry.
    pub entry: EntryId,
    /// Interned name that carries this entry.
    pub name: NameId,
    /// Parent entry slot; EntryId::NIL at the root.
    pub parent: EntryId,
    /// Stable record identity used to detect slot reuse.
    pub record: RecordId,
    /// Size in bytes when known.
    pub size: Option<u64>,
    /// Modification time in nanoseconds since the Unix epoch when known.
    pub modified_ns: Option<i64>,
    /// Whether the index can present a path for this entry.
    pub presentable: bool,
}

/// One matched (name, entry) pair plus its integer sort ranks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub(crate) name: NameId,
    pub(crate) entry: EntryId,
    pub(crate) size_rank: u64,
    pub(crate) modified_rank: u64,
}

/// Scan output before ordering.
pub(crate) struct ScanOutcome {
    pub(crate) candidates: Vec<Candidate>,
    pub(crate) skipped: u64,
}

/// Names per chunk.
const CHUNK_NAMES: usize = 1024;
/// Automatic thread counts stay serial below this many names.
const PARALLEL_MIN_NAMES: usize = 2048;
/// Hard cap on scoped scan threads: a library must not fan out machine-wide.
const MAX_THREADS: usize = 8;
const ABORT_BROAD: u8 = 1;
const ABORT_DEADLINE: u8 = 2;

pub(crate) fn run<S: NameSource + Sync + ?Sized>(
    source: &S,
    plan: &Plan,
    query: &Query,
) -> Result<ScanOutcome, QueryError> {
    let work = build_work(source, plan);
    let threads = effective_threads(query.threads, work.len());
    let tracker = Tracker::new(&query.budget);
    let tracker = &tracker;
    let work = &work;

    let chunks = if threads == 1 {
        scan_worker(source, plan, work, tracker, 0, 1)
    } else {
        let mut panicked = false;
        let parts: Vec<Vec<ChunkDone>> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..threads)
                .map(|thread| {
                    scope.spawn(move || scan_worker(source, plan, work, tracker, thread, threads))
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| match handle.join() {
                    Ok(done) => done,
                    Err(_) => {
                        panicked = true;
                        Vec::new()
                    }
                })
                .collect()
        });
        if panicked {
            return Err(QueryError::WorkerPanicked);
        }
        parts.into_iter().flatten().collect()
    };

    let aborted = tracker.aborted.load(Ordering::Relaxed);
    if aborted != 0 {
        return Err(if aborted & ABORT_DEADLINE != 0 {
            QueryError::DeadlineExceeded
        } else {
            QueryError::TooBroad {
                max: query.budget.max_matches.unwrap_or(0),
            }
        });
    }

    let mut chunks = chunks;
    chunks.sort_unstable_by_key(|chunk| chunk.index);
    let capacity = chunks.iter().map(|chunk| chunk.candidates.len()).sum();
    let mut candidates = Vec::with_capacity(capacity);
    let mut skipped = 0u64;
    for chunk in chunks {
        candidates.extend(chunk.candidates);
        skipped = skipped.saturating_add(chunk.skipped);
    }
    Ok(ScanOutcome {
        candidates,
        skipped,
    })
}

/// Integer sort rank of a size: unknown sorts as the largest possible size.
pub(crate) fn size_rank(size: Option<u64>) -> u64 {
    size.unwrap_or(u64::MAX)
}

/// Integer sort rank of a modification time: unknown sorts as the oldest time.
pub(crate) fn modified_rank(modified_ns: Option<i64>) -> u64 {
    modified_ns.map_or(0, |nanoseconds| (nanoseconds as u64) ^ (1 << 63))
}

enum Work {
    All { count: u32 },
    Names(Vec<NameId>),
}

impl Work {
    fn len(&self) -> usize {
        match self {
            Self::All { count } => *count as usize,
            Self::Names(names) => names.len(),
        }
    }
}

struct ChunkDone {
    index: usize,
    candidates: Vec<Candidate>,
    skipped: u64,
}

struct Tracker {
    deadline: Option<Instant>,
    max_matches: Option<u64>,
    matched: AtomicU64,
    aborted: AtomicU8,
}

impl Tracker {
    fn new(budget: &QueryBudget) -> Self {
        Self {
            deadline: budget.deadline,
            max_matches: budget.max_matches,
            matched: AtomicU64::new(0),
            aborted: AtomicU8::new(0),
        }
    }

    fn stopped(&self) -> bool {
        self.aborted.load(Ordering::Relaxed) != 0
    }

    fn check_deadline(&self) {
        if let Some(deadline) = self.deadline
            && Instant::now() >= deadline
        {
            self.aborted.fetch_or(ABORT_DEADLINE, Ordering::Relaxed);
        }
    }

    fn note_matches(&self, matched: u64) {
        if let Some(max) = self.max_matches {
            let total = self
                .matched
                .fetch_add(matched, Ordering::Relaxed)
                .saturating_add(matched);
            if total > max {
                self.aborted.fetch_or(ABORT_BROAD, Ordering::Relaxed);
            }
        }
    }
}

fn build_work<S: NameSource + ?Sized>(source: &S, plan: &Plan) -> Work {
    match plan.prefilter() {
        Some(needle) => Work::Names(prefilter_names(source, needle)),
        None => Work::All {
            count: source.name_count(),
        },
    }
}

fn prefilter_names<S: NameSource + ?Sized>(source: &S, needle: &[u8]) -> Vec<NameId> {
    let arena = source.folded_arena();
    let mut names = Vec::new();
    for offset in memchr::memmem::find_iter(arena, needle) {
        if let Some(name) = source.folded_name_at(offset)
            && names.last().copied() != Some(name)
        {
            names.push(name);
        }
    }
    names
}

fn effective_threads(requested: usize, names: usize) -> usize {
    let requested = if requested == 0 {
        if names < PARALLEL_MIN_NAMES {
            1
        } else {
            std::thread::available_parallelism()
                .map(|count| count.get())
                .unwrap_or(1)
        }
    } else {
        requested
    };
    let chunks = names.div_ceil(CHUNK_NAMES).max(1);
    requested.clamp(1, MAX_THREADS).min(chunks)
}

fn work_name<S: NameSource + ?Sized>(work: &Work, source: &S, index: usize) -> NameId {
    match work {
        Work::All { .. } => source.name_at(index as u32),
        Work::Names(names) => names[index],
    }
}

fn scan_worker<S: NameSource + Sync + ?Sized>(
    source: &S,
    plan: &Plan,
    work: &Work,
    tracker: &Tracker,
    thread: usize,
    threads: usize,
) -> Vec<ChunkDone> {
    let chunk_count = work.len().div_ceil(CHUNK_NAMES);
    let mut done = Vec::new();
    let mut index = thread;
    while index < chunk_count {
        if tracker.stopped() {
            break;
        }
        tracker.check_deadline();
        if tracker.stopped() {
            break;
        }
        let start = index * CHUNK_NAMES;
        let end = (start + CHUNK_NAMES).min(work.len());
        let mut candidates = Vec::new();
        let mut skipped = 0u64;
        for position in start..end {
            let name = work_name(work, source, position);
            if source.name_folded(name).is_empty() {
                // The empty name belongs to the index root: structural, not a row.
                continue;
            }
            if !plan.matches(source, name) {
                continue;
            }
            source.for_each_name_entry(name, &mut |view: EntryView| {
                if view.presentable {
                    candidates.push(Candidate {
                        name,
                        entry: view.entry,
                        size_rank: size_rank(view.size),
                        modified_rank: modified_rank(view.modified_ns),
                    });
                } else {
                    skipped = skipped.saturating_add(1);
                }
            });
        }
        tracker.note_matches(candidates.len() as u64 + skipped);
        done.push(ChunkDone {
            index,
            candidates,
            skipped,
        });
        index += threads;
    }
    done
}

/// A borrowed pair of index tables, ready to be queried.
///
/// This is the production [NameSource]: a policy layer owns a [NameStore] and
/// an [EntryTable] and hands both to a query without copying either.
#[derive(Clone, Copy)]
pub struct IndexView<'a> {
    /// Interned names with their raw and folded arenas.
    pub names: &'a NameStore,
    /// Entry rows and their same-name chains.
    pub entries: &'a EntryTable,
}

impl<'a> IndexView<'a> {
    /// Wraps one name store and its entry table.
    pub const fn new(names: &'a NameStore, entries: &'a EntryTable) -> Self {
        Self { names, entries }
    }
}

impl NameSource for IndexView<'_> {
    fn folded_arena(&self) -> &[u8] {
        self.names.folded()
    }

    fn name_count(&self) -> u32 {
        u32::try_from(self.names.slot_count()).expect("name ids are 32-bit by construction")
    }

    fn name_at(&self, ordinal: u32) -> NameId {
        NameId::new(ordinal)
    }

    fn name_raw(&self, name: NameId) -> &[u8] {
        self.names.raw_bytes(name)
    }

    fn name_folded(&self, name: NameId) -> &[u8] {
        self.names.folded_bytes(name)
    }

    fn folded_name_at(&self, offset: usize) -> Option<NameId> {
        self.names.folded_name_at(offset)
    }

    fn for_each_name_entry(&self, name: NameId, visit: &mut dyn FnMut(EntryView)) {
        for entry in self.names.name_chain(name, self.entries) {
            if let Some(view) = self.entries.get(entry) {
                visit(index_entry(entry, view));
            }
        }
    }

    fn entry(&self, entry: EntryId) -> Option<EntryView> {
        self.entries.get(entry).map(|view| index_entry(entry, view))
    }
}

fn index_entry(entry: EntryId, view: crate::index::EntryView) -> EntryView {
    EntryView {
        entry,
        name: view.name_id(),
        parent: view.parent(),
        record: view.record(),
        size: view.size(),
        modified_ns: view.mtime(),
        presentable: view.is_presentable(),
    }
}

#[cfg(test)]
#[path = "scan_tests.rs"]
mod scan_tests;
