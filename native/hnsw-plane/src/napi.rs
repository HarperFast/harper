//! NAPI surface (feature = "napi"). One boundary crossing per operation; searches run on
//! the libuv thread pool via AsyncTask so the JS event loop is never blocked (C1).
//! The surface is deliberately Harper-agnostic — pk↔id mapping, commit-callback glue, and
//! txnlog-anchored replay live in the host application.

use crate::distance::Query;
use crate::insert::{insert, InsertParams};
use crate::search::{search_filtered, search_predicated, PredicatePipe, SearchScratch};
use crate::{Graph, PlaneFile};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::JsFunction;
use napi_derive::napi;
use std::sync::{Arc, Mutex};

/// Pooled per-query scratch (the visited array is O(nodes); never allocate per query).
struct ScratchPool(Mutex<Vec<SearchScratch>>);

impl ScratchPool {
    fn take(&self) -> SearchScratch {
        self.0.lock().unwrap().pop().unwrap_or_default()
    }
    fn put(&self, s: SearchScratch) {
        let mut pool = self.0.lock().unwrap();
        if pool.len() < 64 {
            pool.push(s);
        }
    }
}

#[napi(object)]
pub struct SearchHit {
    pub id: u32,
    pub distance: f64,
}

pub struct SearchTask {
    graph: Arc<Graph>,
    pool: Arc<ScratchPool>,
    query: Vec<f32>,
    k: usize,
    ef: usize,
    filter: Option<Vec<u8>>,
    filter_expansion: usize,
}

#[napi]
impl Task for SearchTask {
    type Output = Vec<(u32, f32)>;
    type JsValue = Vec<SearchHit>;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut scratch = self.pool.take();
        let query = Query::new(std::mem::take(&mut self.query));
        let (hits, _stats) = search_filtered(
            &self.graph,
            &query,
            self.k,
            self.ef,
            self.filter.as_deref(),
            self.filter_expansion,
            &mut scratch,
        );
        self.pool.put(scratch);
        Ok(hits)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into_iter().map(|(id, d)| SearchHit { id, distance: d as f64 }).collect())
    }
}

pub struct PredicateSearchTask {
    graph: Arc<Graph>,
    pool: Arc<ScratchPool>,
    query: Vec<f32>,
    k: usize,
    ef: usize,
    tsfn: Option<ThreadsafeFunction<Vec<u32>, ErrorStrategy::Fatal>>,
    visit_budget: u64,
}

#[napi]
impl Task for PredicateSearchTask {
    type Output = Vec<(u32, f32)>;
    type JsValue = Vec<SearchHit>;

    fn compute(&mut self) -> Result<Self::Output> {
        let tsfn = self.tsfn.take().ok_or_else(|| Error::from_reason("task reused"))?;
        let (tx, rx) = std::sync::mpsc::channel::<(Vec<u32>, Vec<u8>)>();
        let mut pipe = PredicatePipe {
            dispatch: Box::new(move |ids: Vec<u32>| {
                let tx = tx.clone();
                let ids_echo = ids.clone();
                tsfn.call_with_return_value(
                    ids,
                    ThreadsafeFunctionCallMode::NonBlocking,
                    move |ret: Uint8Array| {
                        // predicate errors / env teardown surface as a missing send; the
                        // drain deadline in search_predicated treats absent verdicts as deny
                        let _ = tx.send((ids_echo, ret.to_vec()));
                        Ok(())
                    },
                );
            }),
            rx,
        };
        let mut scratch = self.pool.take();
        let query = Query::new(std::mem::take(&mut self.query));
        let (hits, _stats) =
            search_predicated(&self.graph, &query, self.k, self.ef, &mut pipe, self.visit_budget, &mut scratch);
        self.pool.put(scratch);
        Ok(hits)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into_iter().map(|(id, d)| SearchHit { id, distance: d as f64 }).collect())
    }
}

pub struct FlushTask {
    graph: Arc<Graph>,
    txn: Option<u64>,
}

#[napi]
impl Task for FlushTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        self.graph.file.flush_with_watermark(self.txn).map_err(|e| Error::from_reason(e.to_string()))
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub struct Plane {
    graph: Arc<Graph>,
    pool: Arc<ScratchPool>,
    params: InsertParams,
    // insert scratch, serialized: phase-1 hosts call insert from a single writer at a time
    // per index (Harper's commit path); a Mutex keeps misuse safe rather than fast.
    insert_scratch: Mutex<SearchScratch>,
}

#[napi]
impl Plane {
    /// Create a new plane file. `maxNodes` bounds the sparse reservation (pages materialize
    /// on write).
    #[napi(factory)]
    pub fn create(path: String, dims: u32, layer0_cap: u32, max_nodes: f64) -> Result<Plane> {
        let file = PlaneFile::create(std::path::Path::new(&path), dims as usize, layer0_cap as usize, max_nodes as u64)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Self::wrap(file))
    }

    /// Open an existing plane file (the upper-layer region lives in the same file).
    #[napi(factory)]
    pub fn open(path: String) -> Result<Plane> {
        let file = PlaneFile::open(std::path::Path::new(&path)).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Self::wrap(file))
    }

    fn wrap(file: PlaneFile) -> Plane {
        Plane {
            graph: Arc::new(Graph::new(file)),
            pool: Arc::new(ScratchPool(Mutex::new(Vec::new()))),
            params: InsertParams::default(),
            insert_scratch: Mutex::new(SearchScratch::new()),
        }
    }

    /// Insert a vector; returns the allocated node id (freelist ids are reused). Throws on
    /// a dimension mismatch or a full plane (maxNodes reached).
    #[napi]
    pub fn insert(&self, vector: Float32Array) -> Result<u32> {
        if vector.len() != self.graph.file.dims {
            return Err(Error::from_reason(format!(
                "vector has {} dims; plane was created with {}",
                vector.len(),
                self.graph.file.dims
            )));
        }
        for (i, v) in vector.iter().enumerate() {
            if !v.is_finite() {
                // a NaN component yields a huge invMag and -inf distances: that node would
                // rank first for roughly half of all queries, permanently
                return Err(Error::from_reason(format!("vector component {i} is not finite")));
            }
        }
        let mut scratch = self.insert_scratch.lock().unwrap();
        insert(&self.graph, &vector, &self.params, &mut scratch)
            .ok_or_else(|| Error::from_reason("plane is full (maxNodes reached)"))
    }

    /// Delete a node; its id returns to the plane freelist. Standalone-allocation mode only
    /// (pairs with insert()); dual-write hosts use clearNode instead.
    #[napi]
    pub fn remove(&self, id: u32) {
        self.graph.delete_node(id);
    }

    /// Mirror a host-maintained node into the plane (dual-write phase 1): full node state
    /// per call, host-allocated id, int8 vector bin + quantization scale + cached 1/|v|,
    /// layer-0 neighbor ids, and per-upper-level neighbor id arrays (level 1 first). An
    /// existing upper entry is rewritten in place. Idempotent per (id, state).
    #[napi]
    pub fn write_node_raw(
        &self,
        id: u32,
        level: u8,
        vector: Buffer,
        scale: f64,
        inv_mag: f64,
        neighbors: Uint32Array,
        upper: Option<Vec<Uint32Array>>,
    ) -> Result<()> {
        if vector.len() != self.graph.file.dims {
            return Err(Error::from_reason(format!(
                "vector is {} bytes; plane dims = {}",
                vector.len(),
                self.graph.file.dims
            )));
        }
        // ensure_high_water + slot_ptr have no bounds check, so a host id past the fixed
        // reservation would address past the slot region (mmap overrun) — reject it here.
        if id as u64 >= self.graph.file.max_nodes {
            return Err(Error::from_reason(format!(
                "node id {} exceeds the plane's maxNodes reservation ({})",
                id, self.graph.file.max_nodes
            )));
        }
        if (id as u64) >= self.graph.file.max_nodes {
            return Err(Error::from_reason(format!("id {} exceeds plane capacity {}", id, self.graph.file.max_nodes)));
        }
        if !(scale as f32).is_finite() || !(inv_mag as f32).is_finite() {
            return Err(Error::from_reason("scale/invMag must be finite"));
        }
        let vec_i8 = unsafe { std::slice::from_raw_parts(vector.as_ptr() as *const i8, vector.len()) };
        let upper_levels: Vec<Vec<u32>> =
            upper.map(|ls| ls.iter().map(|l| l.to_vec()).collect()).unwrap_or_default();
        // reject out-of-range neighbor ids rather than letting them poison traversal
        // (SearchScratch::visit would size its array from them; distance_to skips them, but
        // a u32::MAX id costs a huge allocation before it is skipped)
        let max = self.graph.file.max_nodes;
        for &n in neighbors.iter() {
            if (n as u64) >= max {
                return Err(Error::from_reason(format!("neighbor id {n} exceeds plane capacity {max}")));
            }
        }
        for level in &upper_levels {
            for &n in level {
                if (n as u64) >= max {
                    return Err(Error::from_reason(format!("upper neighbor id {n} exceeds plane capacity {max}")));
                }
            }
        }
        self.graph.write_node_raw(
            id,
            level,
            vec_i8,
            scale as f32,
            inv_mag as f32,
            &neighbors.to_vec(),
            &upper_levels,
        );
        Ok(())
    }

    /// Builder-scan variant of writeNodeRaw: writes ONLY when the slot has never been
    /// touched (valid or deleted). A backfill scan mirroring a snapshot must not overwrite
    /// a node a concurrent live mirror already wrote with newer state — the check and the
    /// write happen under the slot's seqlock, so the race is closed across workers too.
    /// Returns true when the scan's state was written.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn write_node_raw_if_absent(
        &self,
        id: u32,
        level: u8,
        vector: Buffer,
        scale: f64,
        inv_mag: f64,
        neighbors: Uint32Array,
        upper: Option<Vec<Uint32Array>>,
    ) -> Result<bool> {
        if vector.len() != self.graph.file.dims {
            return Err(Error::from_reason(format!(
                "vector is {} bytes; plane dims = {}",
                vector.len(),
                self.graph.file.dims
            )));
        }
        if (id as u64) >= self.graph.file.max_nodes {
            return Err(Error::from_reason(format!("id {} exceeds plane capacity {}", id, self.graph.file.max_nodes)));
        }
        if !(scale as f32).is_finite() || !(inv_mag as f32).is_finite() {
            return Err(Error::from_reason("scale/invMag must be finite"));
        }
        let max = self.graph.file.max_nodes;
        for &n in neighbors.iter() {
            if (n as u64) >= max {
                return Err(Error::from_reason(format!("neighbor id {n} exceeds plane capacity {max}")));
            }
        }
        let upper_levels: Vec<Vec<u32>> =
            upper.map(|ls| ls.iter().map(|l| l.to_vec()).collect()).unwrap_or_default();
        for level_ids in &upper_levels {
            for &n in level_ids {
                if (n as u64) >= max {
                    return Err(Error::from_reason(format!("upper neighbor id {n} exceeds plane capacity {max}")));
                }
            }
        }
        let vec_i8 = unsafe { std::slice::from_raw_parts(vector.as_ptr() as *const i8, vector.len()) };
        let mut l0 = neighbors.to_vec();
        l0.truncate(self.graph.file.layer0_cap);
        // the untouched check and the write share one seqlock acquisition inside the crate:
        // a live mirror's newer write can never be overwritten by this scan's older snapshot
        Ok(self.graph.write_node_if_untouched(id, level, vec_i8, scale as f32, inv_mag as f32, &l0, &upper_levels))
    }

    /// Advisory: whether the file recorded a durability barrier (flush) as its last state
    /// when this handle opened it. Crash recovery does not depend on it — torn per-slot
    /// locks are taken over lazily at the affected slot.
    #[napi]
    pub fn opened_clean(&self) -> bool {
        self.graph.file.opened_clean
    }

    /// Async durability barrier on the libuv pool: same ordering contract as flush(), off
    /// the event loop — a whole-map msync over a large mapping stalls its calling thread.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn flush_async(&self, watermark: Option<f64>) -> AsyncTask<FlushTask> {
        let txn = watermark.map(|w| w as u64);
        AsyncTask::new(FlushTask { graph: self.graph.clone(), txn })
    }

    /// Mark a node deleted without touching the plane freelist (dual-write mode: the host
    /// owns id allocation).
    #[napi]
    pub fn clear_node(&self, id: u32) {
        self.graph.clear_node(id);
    }

    /// Set the graph entry point (dual-write mode mirrors the host's entry-point updates).
    #[napi]
    pub fn set_entry_point(&self, id: u32, level: u32) {
        // clamp: a garbage level would make every search iterate that many empty levels
        self.graph.file.set_entry_point(id, level.min(crate::format::MAX_UPPER_LEVELS as u32));
    }

    #[napi]
    pub fn get_entry_point(&self) -> Vec<f64> {
        let (id, level) = self.graph.file.entry_point();
        vec![id as f64, level as f64]
    }

    /// Query dimensionality must match the plane: the distance kernel streams
    /// `query.len()` bytes from each slot's vector, so an oversized query would read past
    /// it into adjacent slot bytes (or off the mapping entirely).
    fn check_query_dims(&self, len: usize) -> Result<()> {
        if len != self.graph.file.dims {
            return Err(Error::from_reason(format!(
                "query vector has {} dimensions; plane dims = {}",
                len, self.graph.file.dims
            )));
        }
        Ok(())
    }

    #[napi(getter)]
    pub fn dims(&self) -> u32 {
        self.graph.file.dims as u32
    }

    #[napi(getter)]
    pub fn layer0_cap(&self) -> u32 {
        self.graph.file.layer0_cap as u32
    }

    /// Async k-NN search on the libuv thread pool. `filter` is an optional allow-bitset
    /// over node ids (bit i of byte i>>3); filtered searches are visit-bounded by
    /// ef * filterExpansion (default 24).
    #[napi(ts_return_type = "Promise<Array<SearchHit>>")]
    pub fn search(
        &self,
        vector: Float32Array,
        k: u32,
        ef: u32,
        filter: Option<Uint8Array>,
        filter_expansion: Option<u32>,
    ) -> Result<AsyncTask<SearchTask>> {
        self.check_query_dims(vector.len())?;
        Ok(AsyncTask::new(SearchTask {
            graph: self.graph.clone(),
            pool: self.pool.clone(),
            query: vector.to_vec(),
            k: k as usize,
            ef: ef as usize,
            filter: filter.map(|f| f.to_vec()),
            filter_expansion: filter_expansion.unwrap_or(24) as usize,
        }))
    }

    /// Async k-NN search with a JS predicate: `predicate(ids: number[]) => Uint8Array`
    /// (one 0/1 byte per id, evaluated synchronously). Batches of candidate ids stream to
    /// the predicate over a ThreadsafeFunction while traversal keeps expanding — the search
    /// thread never blocks on the JS event loop until the beam itself is done, so a busy
    /// loop costs speculative overshoot (bounded by the visit budget), not latency.
    /// `visitBudget` caps layer-0 visits absolutely (a host budget may sit below ef, which a
    /// multiplier cannot express); when absent the budget is ef * filterExpansion.
    /// Must not be awaited synchronously from code the predicate itself blocks.
    #[napi(ts_return_type = "Promise<Array<SearchHit>>")]
    pub fn search_with_predicate(
        &self,
        vector: Float32Array,
        k: u32,
        ef: u32,
        #[napi(ts_arg_type = "(ids: Array<number>) => Uint8Array")] predicate: JsFunction,
        filter_expansion: Option<u32>,
        visit_budget: Option<f64>,
    ) -> Result<AsyncTask<PredicateSearchTask>> {
        self.check_query_dims(vector.len())?;
        let tsfn: ThreadsafeFunction<Vec<u32>, ErrorStrategy::Fatal> = predicate
            .create_threadsafe_function(0, |ctx: napi::threadsafe_function::ThreadSafeCallContext<Vec<u32>>| {
                let ids: Vec<f64> = ctx.value.iter().map(|&v| v as f64).collect();
                Ok(vec![ids])
            })?;
        let ef = ef as usize;
        Ok(AsyncTask::new(PredicateSearchTask {
            graph: self.graph.clone(),
            pool: self.pool.clone(),
            query: vector.to_vec(),
            k: k as usize,
            ef,
            tsfn: Some(tsfn),
            visit_budget: visit_budget
                .map(|b| b.max(1.0) as u64)
                .unwrap_or((ef * filter_expansion.unwrap_or(24) as usize) as u64),
        }))
    }

    /// Synchronous search (benchmarks/tests; blocks the calling thread).
    #[napi]
    pub fn search_sync(&self, vector: Float32Array, k: u32, ef: u32) -> Result<Vec<SearchHit>> {
        self.check_query_dims(vector.len())?;
        let mut scratch = self.pool.take();
        let query = Query::new(vector.to_vec());
        let (hits, _) = search_filtered(&self.graph, &query, k as usize, ef as usize, None, 24, &mut scratch);
        self.pool.put(scratch);
        Ok(hits.into_iter().map(|(id, d)| SearchHit { id, distance: d as f64 }).collect())
    }

    /// Lifetime id high-water (allocated ids, including freed ones awaiting reuse).
    #[napi]
    pub fn id_high_water(&self) -> f64 {
        self.graph.file.id_high_water() as f64
    }

    #[napi]
    pub fn get_watermark(&self) -> f64 {
        self.graph.file.watermark() as f64
    }

    #[napi]
    pub fn set_watermark(&self, txn: f64) {
        self.graph.file.set_watermark(txn as u64);
    }

    /// Durability barrier: flush all data, then advance the watermark (defaults to the
    /// current one) and the clean-shutdown flag, then flush the header alone — so a crash
    /// between the flushes can only leave an OLD watermark over durable data (replay
    /// re-covers a suffix), never a new watermark over missing data.
    #[napi]
    pub fn flush(&self, watermark: Option<f64>) -> Result<()> {
        self.graph.file.flush_with_watermark(watermark.map(|w| w as u64)).map_err(|e| Error::from_reason(e.to_string()))
    }
}
