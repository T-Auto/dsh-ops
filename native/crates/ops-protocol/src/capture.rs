//! Bounded pre-display capture shared by independent kernel crates. No filesystem authority lives here.
use crate::Failure;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    io::{self, Write},
};
const CAPTURE_BYTES: usize = 10 * 1024 * 1024 - 32768;
const CHUNK_BYTES: usize = 2048;
#[derive(Default)]
pub struct Captured {
    pub records: Vec<Value>,
    pub source: Value,
    pub logical_items: usize,
    pub observed_items: usize,
    pub clipped: bool,
    pub error: Option<Failure>,
    bytes: usize,
}
#[derive(Default)]
pub struct OutputSink(RefCell<Captured>);
impl OutputSink {
    pub fn push(&self, item: &Value) {
        let mut state = self.0.borrow_mut();
        state.observed_items += 1;
        if state.error.is_some() {
            return;
        }
        let (start, bytes, index) = (state.records.len(), state.bytes, state.logical_items);
        let saved = if json_size(item) <= 4096 {
            state.record(json!({"kind":"item","index":index,"value":item}))
        } else {
            let mut writer = ChunkWriter {
                state: &mut state,
                index,
                chunk: 0,
                offset: 0,
                pending: Vec::new(),
            };
            serde_json::to_writer(&mut writer, item)
                .map_err(io::Error::other)
                .and_then(|()| writer.finish())
        };
        if saved.is_err() {
            state.records.truncate(start);
            state.bytes = bytes;
            state.error = Some(Failure::new(
                "QUOTA_EXCEEDED",
                "Output capture reached the 10 MiB snapshot budget; only preceding whole logical items were retained",
            ));
        } else {
            state.logical_items += 1;
        }
    }
    pub fn source(&self, mut source: Value) {
        if let Some(object) = source.as_object_mut() {
            object.remove("items");
        }
        self.0.borrow_mut().source = source;
    }
    pub fn last_source(&self) -> Value {
        self.0.borrow().source.clone()
    }
    pub fn clipped(&self) {
        self.0.borrow_mut().clipped = true;
    }
    pub fn exhausted(&self) -> bool {
        self.0.borrow().error.is_some()
    }
    pub fn take(&self) -> Captured {
        std::mem::take(&mut *self.0.borrow_mut())
    }
}
impl Captured {
    fn record(&mut self, value: Value) -> io::Result<()> {
        let cost = json_size(&value) + 1;
        if self.bytes.saturating_add(cost) > CAPTURE_BYTES {
            return Err(io::Error::other("capture quota"));
        }
        self.bytes += cost;
        self.records.push(value);
        Ok(())
    }
}
struct ChunkWriter<'a> {
    state: &'a mut Captured,
    index: usize,
    chunk: usize,
    offset: usize,
    pending: Vec<u8>,
}
impl ChunkWriter<'_> {
    fn emit(&mut self) -> io::Result<()> {
        let end = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(error) => error.valid_up_to(),
        };
        if end == 0 {
            return Ok(());
        }
        let text = std::str::from_utf8(&self.pending[..end])
            .map_err(io::Error::other)?
            .to_owned();
        self.state.record(json!({"kind":"item-json-chunk","index":self.index,"chunk":self.chunk,"byteOffset":self.offset,"text":text,"complete":false}))?;
        self.offset += end;
        self.chunk += 1;
        self.pending.drain(..end);
        Ok(())
    }
    fn finish(&mut self) -> io::Result<()> {
        self.emit()?;
        if !self.pending.is_empty() || self.chunk == 0 {
            return Err(io::Error::other("incomplete JSON encoding"));
        }
        self.state.records.last_mut().unwrap()["complete"] = json!(true);
        self.state.bytes -= 1; // true is one serialized byte shorter than false.
        Ok(())
    }
}
impl Write for ChunkWriter<'_> {
    fn write(&mut self, mut bytes: &[u8]) -> io::Result<usize> {
        let total = bytes.len();
        while !bytes.is_empty() {
            let count = (CHUNK_BYTES - self.pending.len()).min(bytes.len());
            self.pending.extend_from_slice(&bytes[..count]);
            bytes = &bytes[count..];
            if self.pending.len() == CHUNK_BYTES {
                self.emit()?;
            }
        }
        Ok(total)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
/// Count escaped JSON bytes without allocating a potentially huge encoded string.
pub fn json_size(value: &Value) -> usize {
    struct Counter(usize);
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut count = Counter(0);
    serde_json::to_writer(&mut count, value).expect("JSON value serializes");
    count.0
}
