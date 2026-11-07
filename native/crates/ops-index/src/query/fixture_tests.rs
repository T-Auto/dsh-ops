//! A small, finite NameSource for query tests.
//!
//! The fixture interns raw names (folded with the crate's real fold), keeps one
//! chain per name so hard-link-shaped duplicates are exercised, and lets a test
//! mark an entry unpresentable. It is deliberately tiny and obviously correct;
//! oracle and property tests compare the query engine against a naive scan of
//! its names.

use std::collections::HashMap;

use crate::fold;
use crate::ids::{EntryId, NameId, RecordId};
use crate::query::scan::{self, Candidate};
use crate::query::{EntryView, NameSource};

/// Fields a test can set when adding an entry.
#[derive(Clone, Copy, Debug)]
pub(crate) struct EntryOptions {
    /// Size in bytes.
    pub size: Option<u64>,
    /// Modification time in nanoseconds.
    pub modified_ns: Option<i64>,
    /// Whether the entry can be presented as a path.
    pub presentable: bool,
    /// Parent entry slot.
    pub parent: EntryId,
}

impl Default for EntryOptions {
    fn default() -> Self {
        Self {
            size: None,
            modified_ns: None,
            presentable: true,
            parent: EntryId::NIL,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct StoredEntry {
    name: NameId,
    parent: EntryId,
    record: RecordId,
    size: Option<u64>,
    modified_ns: Option<i64>,
    next: EntryId,
    presentable: bool,
}

impl StoredEntry {
    fn view(&self, entry: EntryId) -> EntryView {
        EntryView {
            entry,
            name: self.name,
            parent: self.parent,
            record: self.record,
            size: self.size,
            modified_ns: self.modified_ns,
            presentable: self.presentable,
        }
    }
}

/// In-memory name source used by query tests.
#[derive(Clone, Debug, Default)]
pub(crate) struct TestSource {
    folded: Vec<u8>,
    spans: Vec<(u32, u32)>,
    raws: Vec<Vec<u8>>,
    heads: Vec<EntryId>,
    tails: Vec<EntryId>,
    entries: Vec<StoredEntry>,
    by_raw: HashMap<Vec<u8>, NameId>,
}

impl TestSource {
    /// Creates an empty source.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Interns a name and appends one entry to its chain.
    pub(crate) fn add(&mut self, raw: &[u8]) -> EntryId {
        self.add_with(raw, EntryOptions::default())
    }

    /// Interns a name and appends one entry with explicit fields.
    pub(crate) fn add_with(&mut self, raw: &[u8], options: EntryOptions) -> EntryId {
        let name = self.intern(raw);
        let entry = EntryId::new(self.entries.len() as u32);
        let record = RecordId::new(0x1000 + self.entries.len() as u64);
        let previous = self.tails[name.index()];
        self.entries.push(StoredEntry {
            name,
            parent: options.parent,
            record,
            size: options.size,
            modified_ns: options.modified_ns,
            next: EntryId::NIL,
            presentable: options.presentable,
        });
        if self.heads[name.index()].is_nil() {
            self.heads[name.index()] = entry;
        } else {
            self.entries[previous.index()].next = entry;
        }
        self.tails[name.index()] = entry;
        entry
    }

    /// Changes whether an entry can be presented as a path.
    pub(crate) fn set_presentable(&mut self, entry: EntryId, presentable: bool) {
        self.entries[entry.index()].presentable = presentable;
    }

    /// Interned name id for a raw name that was added earlier.
    pub(crate) fn name_of(&self, raw: &[u8]) -> NameId {
        *self.by_raw.get(raw).expect("name was interned")
    }

    /// Scan-shaped candidates for every entry, in entry-id order.
    pub(crate) fn candidates_in_entry_order(&self) -> Vec<Candidate> {
        (0..self.entries.len())
            .map(|index| {
                let entry = EntryId::new(index as u32);
                let view = self.entry(entry).expect("fixture entry exists");
                Candidate {
                    name: view.name,
                    entry,
                    size_rank: scan::size_rank(view.size),
                    modified_rank: scan::modified_rank(view.modified_ns),
                }
            })
            .collect()
    }

    fn intern(&mut self, raw: &[u8]) -> NameId {
        if let Some(existing) = self.by_raw.get(raw) {
            return *existing;
        }
        let name = NameId::new(self.raws.len() as u32);
        let folded = fold::fold(raw);
        let offset = self.folded.len() as u32;
        self.folded.extend_from_slice(&folded);
        self.folded.push(0);
        self.spans.push((offset, folded.len() as u32));
        self.raws.push(raw.to_vec());
        self.heads.push(EntryId::NIL);
        self.tails.push(EntryId::NIL);
        self.by_raw.insert(raw.to_vec(), name);
        name
    }
}

impl NameSource for TestSource {
    fn folded_arena(&self) -> &[u8] {
        &self.folded
    }

    fn name_count(&self) -> u32 {
        self.spans.len() as u32
    }

    fn name_at(&self, ordinal: u32) -> NameId {
        NameId::new(ordinal)
    }

    fn name_raw(&self, name: NameId) -> &[u8] {
        &self.raws[name.index()]
    }

    fn name_folded(&self, name: NameId) -> &[u8] {
        let (offset, len) = self.spans[name.index()];
        let start = offset as usize;
        &self.folded[start..start + len as usize]
    }

    fn folded_name_at(&self, offset: usize) -> Option<NameId> {
        let offset = u32::try_from(offset).ok()?;
        let mut low = 0usize;
        let mut high = self.spans.len();
        while low < high {
            let middle = (low + high) / 2;
            let (start, len) = self.spans[middle];
            if offset < start {
                high = middle;
            } else if offset >= start.saturating_add(len) {
                low = middle + 1;
            } else {
                return Some(NameId::new(middle as u32));
            }
        }
        None
    }

    fn for_each_name_entry(&self, name: NameId, visit: &mut dyn FnMut(EntryView)) {
        let mut entry = self.heads[name.index()];
        while !entry.is_nil() {
            let stored = self.entries[entry.index()];
            visit(stored.view(entry));
            entry = stored.next;
        }
    }

    fn entry(&self, entry: EntryId) -> Option<EntryView> {
        self.entries
            .get(entry.index())
            .map(|stored| stored.view(entry))
    }
}
