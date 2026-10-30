//! Bounded session-only context; no persistence, raw-audio storage or user traits.
use std::collections::{hash_map::DefaultHasher, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_BUFFER: AtomicU64 = AtomicU64::new(1);
const RETIRED_RECORDS: usize = 256;
#[derive(Clone, PartialEq, Eq)]
struct Revision {
    seq: u64,
    revision: u64,
    fingerprint: u64,
}
#[derive(Clone, PartialEq, Eq)]
struct Segment {
    source: Revision,
    text: String,
}
#[derive(Clone)]
pub struct SummaryTicket {
    buffer_id: u64,
    base_version: u64,
    segments: Vec<Segment>,
    pub previous_summary: Option<String>,
}
impl SummaryTicket {
    /// Private summarizer input. Never log this text.
    pub fn text(&self) -> String {
        self.segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
}
pub struct Context {
    pub summary: Option<String>,
    pub recent: String,
    pub has_gap: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Update {
    Added,
    Revised,
    Duplicate,
    Stale,
    Compacted,
    Conflict,
    Invalid,
}
pub struct ListeningBuffer {
    // Instance identity also rejects a late reply when a caller reuses a session label.
    buffer_id: u64,
    segments: VecDeque<Segment>,
    retired: VecDeque<Revision>,
    raw_limit: usize,
    recent_limit: usize,
    summary_limit: usize,
    summary: Option<String>,
    summary_version: u64,
    retired_until: u64,
    last_seq: u64,
    has_gap: bool,
}
fn suffix(text: &str, chars: usize) -> String {
    let skip = text.chars().count().saturating_sub(chars);
    text.chars().skip(skip).collect()
}
// Deduplication only, never an authentication or cryptographic integrity check.
fn fingerprint(text: &str) -> u64 {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}
fn prior_update(old: &Revision, new: &Revision) -> Option<Update> {
    if new.revision < old.revision {
        Some(Update::Stale)
    } else if new.revision == old.revision {
        Some(if new.fingerprint == old.fingerprint {
            Update::Duplicate
        } else {
            Update::Conflict
        })
    } else {
        None
    }
}
impl ListeningBuffer {
    pub fn new(raw: usize, recent: usize, summary: usize) -> Option<Self> {
        if raw == 0 || recent == 0 || recent > raw || summary == 0 {
            return None;
        }
        Some(Self {
            buffer_id: NEXT_BUFFER.fetch_add(1, Ordering::Relaxed),
            segments: VecDeque::new(),
            retired: VecDeque::new(),
            raw_limit: raw,
            recent_limit: recent,
            summary_limit: summary,
            summary: None,
            summary_version: 0,
            retired_until: 0,
            last_seq: 0,
            has_gap: false,
        })
    }
    fn retire(&mut self, source: Revision) {
        self.retired_until = source.seq;
        self.retired.push_back(source);
        if self.retired.len() > RETIRED_RECORDS {
            self.retired.pop_front();
        }
    }
    pub fn upsert(&mut self, seq: u64, revision: u64, text: &str) -> Update {
        let text = text.trim();
        if seq == 0 || revision == 0 || text.is_empty() {
            return Update::Invalid;
        }
        let source = Revision {
            seq,
            revision,
            fingerprint: fingerprint(text),
        };
        if seq <= self.retired_until {
            if let Some(old) = self.retired.iter_mut().find(|s| s.seq == seq) {
                if let Some(result) = prior_update(old, &source) {
                    return result;
                }
                *old = source;
            }
            // Higher revisions or entries older than our bounded ledger cannot be re-summarized.
            self.summary = None;
            self.summary_version += 1;
            self.has_gap = true;
            return Update::Compacted;
        }
        let clipped = text.chars().count() > self.raw_limit;
        let result = if let Some(segment) = self.segments.iter_mut().find(|s| s.source.seq == seq) {
            if let Some(result) = prior_update(&segment.source, &source) {
                return result;
            }
            segment.source = source;
            segment.text = suffix(text, self.raw_limit);
            Update::Revised
        } else {
            if seq <= self.last_seq {
                self.has_gap = true;
                return Update::Stale;
            }
            if seq != self.last_seq + 1 {
                self.has_gap = true;
            }
            self.last_seq = seq;
            self.segments.push_back(Segment {
                source,
                text: suffix(text, self.raw_limit),
            });
            Update::Added
        };
        self.has_gap |= clipped;
        while self.raw_chars() > self.raw_limit {
            self.has_gap = true;
            let lost = self.segments.pop_front().expect("bounded nonempty buffer");
            self.retire(lost.source);
        }
        result
    }
    pub fn context(&self) -> Context {
        let raw = self
            .segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        Context {
            summary: self.summary.clone(),
            recent: suffix(&raw, self.recent_limit),
            has_gap: self.has_gap || raw.chars().count() > self.recent_limit,
        }
    }
    pub fn raw_chars(&self) -> usize {
        self.segments.iter().map(|s| s.text.chars().count()).sum()
    }
    pub fn summary_ticket(&self) -> Option<SummaryTicket> {
        let mut keep = 0;
        let mut cut = self.segments.len();
        for s in self.segments.iter().rev() {
            keep += s.text.chars().count();
            cut -= 1;
            if keep >= self.recent_limit {
                break;
            }
        }
        if cut == 0 {
            return None;
        }
        Some(SummaryTicket {
            buffer_id: self.buffer_id,
            base_version: self.summary_version,
            segments: self.segments.iter().take(cut).cloned().collect(),
            previous_summary: self.summary.clone(),
        })
    }
    pub fn apply_summary(&mut self, ticket: SummaryTicket, text: &str) -> bool {
        let text = text.trim();
        if text.is_empty()
            || text.chars().count() > self.summary_limit
            || ticket.buffer_id != self.buffer_id
            || ticket.base_version != self.summary_version
            || ticket.segments.is_empty()
        {
            return false;
        }
        if self.segments.len() < ticket.segments.len()
            || !self
                .segments
                .iter()
                .take(ticket.segments.len())
                .eq(ticket.segments.iter())
        {
            return false;
        }
        for _ in &ticket.segments {
            let covered = self.segments.pop_front().unwrap();
            self.retire(covered.source);
        }
        self.summary = Some(text.into());
        self.summary_version += 1;
        true
    }
}
