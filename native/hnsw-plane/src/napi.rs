//! NAPI surface (feature = "napi"). One boundary crossing per operation; searches run on
//! the libuv thread pool via AsyncTask so the JS event loop is never blocked (C1).
//! The surface is deliberately Harper-agnostic — pk↔id mapping, commit-callback glue, and
//! txnlog-anchored replay live in the host application.

use crate::distance::Query;
use crate::insert::{insert, InsertParams};
use crate::search::{search_filtered, SearchScratch};
use crate::{Graph, PlaneFile};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::path::PathBuf;
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

#[napi]
pub struct Plane {
    graph: Arc<Graph>,
    pool: Arc<ScratchPool>,
    upper_path: PathBuf,
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
        Ok(Self::wrap(file, &path))
    }

    /// Open an existing plane file and its upper-layer sidecar.
    #[napi(factory)]
    pub fn open(path: String) -> Result<Plane> {
        let file = PlaneFile::open(std::path::Path::new(&path)).map_err(|e| Error::from_reason(e.to_string()))?;
        let plane = Self::wrap(file, &path);
        plane.graph.load_upper(&plane.upper_path).map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(plane)
    }

    fn wrap(file: PlaneFile, path: &str) -> Plane {
        let upper_path = PathBuf::from(format!("{path}.upper"));
        Plane {
            graph: Arc::new(Graph::new(file)),
            pool: Arc::new(ScratchPool(Mutex::new(Vec::new()))),
            upper_path,
            params: InsertParams::default(),
            insert_scratch: Mutex::new(SearchScratch::new()),
        }
    }

    /// Insert a vector; returns the allocated node id (freelist ids are reused).
    #[napi]
    pub fn insert(&self, vector: Float32Array) -> Result<u32> {
        let mut scratch = self.insert_scratch.lock().unwrap();
        Ok(insert(&self.graph, &vector, &self.params, &mut scratch))
    }

    /// Delete a node; its id returns to the freelist.
    #[napi]
    pub fn remove(&self, id: u32) {
        self.graph.delete_node(id);
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
    ) -> AsyncTask<SearchTask> {
        AsyncTask::new(SearchTask {
            graph: self.graph.clone(),
            pool: self.pool.clone(),
            query: vector.to_vec(),
            k: k as usize,
            ef: ef as usize,
            filter: filter.map(|f| f.to_vec()),
            filter_expansion: filter_expansion.unwrap_or(24) as usize,
        })
    }

    /// Synchronous search (benchmarks/tests; blocks the calling thread).
    #[napi]
    pub fn search_sync(&self, vector: Float32Array, k: u32, ef: u32) -> Vec<SearchHit> {
        let mut scratch = self.pool.take();
        let query = Query::new(vector.to_vec());
        let (hits, _) = search_filtered(&self.graph, &query, k as usize, ef as usize, None, 24, &mut scratch);
        self.pool.put(scratch);
        hits.into_iter().map(|(id, d)| SearchHit { id, distance: d as f64 }).collect()
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

    /// msync the plane and persist the upper-layer sidecar; advances durability.
    #[napi]
    pub fn flush(&self) -> Result<()> {
        self.graph.save_upper(&self.upper_path).map_err(|e| Error::from_reason(e.to_string()))?;
        self.graph.file.msync().map_err(|e| Error::from_reason(e.to_string()))
    }
}
