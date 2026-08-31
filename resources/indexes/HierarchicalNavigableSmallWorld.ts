import { closeSync, existsSync, openSync, statSync, unlinkSync } from 'node:fs';
import { cosineDistance, euclideanDistance, dotProductDistance } from './vector.ts';
import { FLOAT32_OPTIONS } from 'msgpackr';
import { loggerWithTag } from '../../utility/logging/logger.ts';
import { ClientError } from '../../utility/errors/hdbError.ts';
import type { Id } from '../../resources/ResourceInterface.ts';
import { SKIP } from '@harperfast/extended-iterable';
import { getPlaneBinding, planeFilePathFor, PLANE_NO_ID, type HnswPlane } from './hnswPlaneBinding.ts';

const logger = loggerWithTag('HNSW');

// int8 scalar quantization of stored graph nodes is ON by default. Each node holds the
// vector as a compact int8 `bin` plus a per-vector `scale`, roughly a 5x size reduction
// over float32 and ~10x cheaper to decode (a single typed-array view instead of decoding
// 768 individually-tagged floats into a boxed Array). The full-precision vector still lives
// on the record, so only graph navigation is approximate:
//   - sort (nearest-neighbor) queries: reranked on exact distances after loading records (~0% recall loss)
//   - lt/le threshold queries: over-fetched and re-filtered on exact distances after loading records
// Opt out per-index with `@indexed(type: "HNSW", quantization: "none")`.
//
// Decode auto-detects the stored format (number[] = float, bin = int8), so indexes written
// before this default change (float nodes) continue to work transparently.

/** Symmetric int8 scalar-quantize a float vector. scale = max|component| / 127. */
function quantizeInt8(vector: number[]): { bytes: Buffer; scale: number } {
	let max = 0;
	for (let i = 0; i < vector.length; i++) {
		const a = vector[i] < 0 ? -vector[i] : vector[i];
		if (a > max) max = a;
	}
	const scale = max / 127 || 1;
	const inv = 1 / scale;
	const q = new Int8Array(vector.length);
	// clamp guards against a float-rounding edge landing on 128 (which Int8Array would wrap to -128)
	for (let i = 0; i < vector.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(vector[i] * inv)));
	return { bytes: Buffer.from(q.buffer, q.byteOffset, q.byteLength), scale };
}

/** Reconstruct an approximate float array from an int8 vector + scale. */
function dequantizeInt8(q: Int8Array, scale: number): number[] {
	const out = new Array(q.length);
	for (let i = 0; i < q.length; i++) out[i] = q[i] * scale;
	return out;
}

/**
 * Connection ids for the plane mirror: ids only — per-edge distances are dropped (recomputed
 * natively). A list past `cap` keeps the NEAREST edges rather than an arbitrary array prefix,
 * so transient JS overshoot (grace above the cap) and the plane's tighter upper cap truncate by
 * the same distance policy the JS prune uses.
 */
function planeConnectionIds(connections: Connection[] | undefined, cap: number): Uint32Array {
	if (!connections?.length) return new Uint32Array(0);
	let usableCount = 0;
	for (const connection of connections) {
		if (typeof connection.id === 'number' && connection.id >= 0) usableCount++;
	}
	if (usableCount > cap) {
		// rare (transient overshoot / the tighter upper cap): worth the intermediate copies
		const nearest = connections
			.filter((connection) => typeof connection.id === 'number' && connection.id >= 0)
			.sort((a, b) => a.distance - b.distance);
		return Uint32Array.from({ length: cap }, (_, i) => nearest[i].id);
	}
	const ids = new Uint32Array(usableCount);
	let at = 0;
	for (const connection of connections) {
		if (typeof connection.id === 'number' && connection.id >= 0) ids[at++] = connection.id;
	}
	return ids;
}

// Auto-scaled search ef, used only when an index does not explicitly configure efConstructionSearch
// and a query does not pass its own ef. A fixed ef makes recall decay as the graph grows (it explores
// a shrinking fraction of the graph), so ef grows with sqrt(node count) in two regimes, with a
// ceiling to bound search cost. The first regime's constants come from the original recall/latency
// sweep (5K-30K, 768-dim cosine, int8) and plateau at AUTO_EF_MAX from ~13K nodes; that plateau was
// calibrated when layers above 0 were searched at the full ef, which made large efs cost seconds.
// After the greedy-descent fix (#2125) ef 1024 at 5M nodes costs ~45ms, and the measured decay at a
// pinned 512 (set-recall 0.997 -> 0.955 -> 0.935 across 1M/2M/5M on well-built graphs, #2181) is
// recall left on the table, so past AUTO_EF_LARGE_REF nodes the scale resumes from that plateau and
// runs to AUTO_EF_CEILING. Validated against the same sweeps: the second regime resolves 1,145 at
// 5M, and the measured ef-1024 point there holds 0.985. Apps preferring latency pin
// efConstructionSearch or a per-query ef; graphs past ~tens of millions of nodes should shard.
const AUTO_EF_BASE = 100;
// The index store holds a graph node plus a primary-key mapping per record, so a key count is twice
// the node count. Sizes here are in nodes; this converts back for the one consumer still calibrated
// against keys.
const INDEX_KEYS_PER_NODE = 2;
// Graph nodes at which ef equals AUTO_EF_BASE. Originally expressed per index-store key against a
// reference of 1000, so 500 nodes is the same point. The node count is a high-water mark rather than
// a live count, so the resolved ef can differ from that formula by one at a rounding boundary.
const AUTO_EF_REF = 500;
const AUTO_EF_MAX = 512;
// Nodes at which the second regime starts: 512 was measured sufficient through 1M (set-recall
// 0.997) and short from 2M up, so the resumed curve is anchored to pass through (1M, 512).
const AUTO_EF_LARGE_REF = 1_000_000;
const AUTO_EF_CEILING = 2048;
function autoScaleEf(nodeCount: number): number {
	if (nodeCount > AUTO_EF_LARGE_REF) {
		const scaled = Math.round(AUTO_EF_MAX * Math.sqrt(nodeCount / AUTO_EF_LARGE_REF));
		return Math.min(AUTO_EF_CEILING, scaled);
	}
	const scaled = Math.round(AUTO_EF_BASE * Math.sqrt(Math.max(1, nodeCount / AUTO_EF_REF)));
	return Math.min(AUTO_EF_MAX, Math.max(AUTO_EF_BASE, scaled));
}

// Candidate-list size used when searching a layer above 0. Those layers only supply the entry point
// for the next layer down, so a greedy walk is enough; a larger value costs work proportional to the
// layer's population without improving the entry point it hands off.
const ROUTING_EF = 1;
// Ceiling on the ef a query's own `offset + limit` can ask for. `limit` is unprivileged and set on
// every request, so this bounds what a caller can make one thread do synchronously: layer 0 holds
// `ef` candidates in a sorted array with an O(len) insert. Kept within a small multiple of the
// index's own auto-scaled ceiling so the worst case stays the same order. Schema and per-query ef
// pins are authoritative cost ceilings; only an automatically scaled index widens from `limit`.
const LIMIT_EF_MAX = 2 * AUTO_EF_CEILING;
// Auto-scaled construction ef, used only when an index does not explicitly configure efConstruction.
// At a constant efConstruction, edge quality erodes as the graph grows until true neighbours become
// unreachable at ANY search ef; the cap bounds per-insert cost. Measurements and policy in
// DESIGN.md ("efConstruction and the search-ef ceiling both auto-scale with the graph") and #2180.
const AUTO_EFC_REF = 250_000;
// Validated to 447 (the 5M point, where the resulting graph held 0.985 set-recall at ef 1024); the
// headroom to 1024 is the same sqrt curve extrapolated, binding at ~26M nodes. Build cost grows
// with the curve (N^1.5 total under sqrt scaling), which is why the cap stays finite: past ~tens of
// millions of nodes, sharded medium graphs beat one huge graph on both build and query cost.
const AUTO_EFC_MAX = 1024;
function autoScaleEfConstruction(nodeCount: number): number {
	const scaled = Math.round(AUTO_EF_BASE * Math.sqrt(Math.max(1, nodeCount / AUTO_EFC_REF)));
	return Math.min(AUTO_EFC_MAX, Math.max(AUTO_EF_BASE, scaled));
}
// How long a resolved graph size is reused before it is looked up again (see approximateNodeCount).
// ef moves with the square root of the count and is capped, so a slightly stale size is immaterial;
// this only has to be short enough that a table growing from empty picks up a larger ef promptly.
const NODE_COUNT_TTL = 10_000;

// Native traversal-plane geometry (see hnsw-native-plane.md). The layer-0 cap is derived from
// M/optimizeRouting at creation to cover the JS graph's effective cap; grace overshoot above it
// truncates by distance. maxNodes is a fixed sparse reservation — pages materialize on write —
// and ids at or past it are rejected by the crate, which disables the plane for this process.
const PLANE_LAYER0_CAP_MAX = 1024;
// Ids kept per upper level — the crate's format-level UPPER_CAP, which truncates whatever is
// passed; pre-sorting to this cap keeps the nearest edges instead of an array prefix.
const PLANE_UPPER_CAP = 32;
const PLANE_MAX_NODES = 1 << 24;
// An existing plane file that cannot be opened is normally another worker mid-create (retry);
// past this age it is a crashed create and is deleted and rebuilt — the plane is derived state,
// the index column family stays authoritative.
const PLANE_STALE_CREATE_MS = 60_000;
// Retry cadence while another worker holds the create: its header lands within moments of the
// exclusive open, so a long deferral would silently drop this worker's mirror writes.
const PLANE_ATTACH_RETRY_MS = 250;
// A plane whose initial mirror never completed (watermark still 0) is never searched; past this
// age the builder is taken as crashed and the file is rebuilt from the CF.
const PLANE_INCOMPLETE_REBUILD_MS = 3_600_000;
// Watermark stamped when the initial full mirror completes; 0 = still building (or crashed
// mid-build). Phase-2 replay wiring will carry real transaction ids, which are also nonzero.
const PLANE_MIRRORED = 1;
// Marks an error thrown by an app-supplied filter during a plane search: the caller re-raises
// it as an ordinary query failure instead of disabling the (healthy) plane.
const PLANE_PREDICATE_ERROR = Symbol('planePredicateError');

class MinHeap {
	private data: Candidate[] = [];
	get size() {
		return this.data.length;
	}
	push(item: Candidate) {
		this.data.push(item);
		let i = this.data.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (this.data[p].distance <= this.data[i].distance) break;
			const tmp = this.data[p];
			this.data[p] = this.data[i];
			this.data[i] = tmp;
			i = p;
		}
	}
	pop(): Candidate | undefined {
		if (this.data.length === 0) return undefined;
		const top = this.data[0];
		const last = this.data.pop()!;
		if (this.data.length > 0) {
			this.data[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1,
					r = l + 1;
				let min = i;
				if (l < this.data.length && this.data[l].distance < this.data[min].distance) min = l;
				if (r < this.data.length && this.data[r].distance < this.data[min].distance) min = r;
				if (min === i) break;
				const tmp = this.data[min];
				this.data[min] = this.data[i];
				this.data[i] = tmp;
				i = min;
			}
		}
		return top;
	}
}

function bisectInsert(arr: Candidate[], distance: number): number {
	let lo = 0,
		hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (arr[mid].distance <= distance) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * Implementation of a vector index for Harper, using hierarchical navigable small world graphs.
 */
const ENTRY_POINT = Symbol.for('entryPoint');
const KEY_PREFIX = Symbol.for('key');
const MAX_LEVEL = 10; // should give good high-level skip list performance up to trillions of nodes
// Visit budget for the post-delete connectivity probe (repairSeveredNeighbors, #1712). Severed
// islands are small (bounded by the deleted node's neighborhood), so a probe that visits this many
// nodes without reaching the entry point is treated as connected-but-far and repaired conservatively.
const PROBE_VISIT_LIMIT = 256;
type Connection = {
	id: number;
	distance: number;
};
type Node = {
	vector: number[] | Int8Array; // float nodes: number[]; quantized nodes: Int8Array (decoded from a bin)
	scale?: number; // int8 dequantization scale; undefined on float nodes
	invMag?: number; // cached 1/|vector| for cosine distance; undefined on legacy nodes
	level?: number;
	primaryKey: string;
	[level: number]: Connection[];
};
/**
 * Represents a Hierarchical Navigable Small World (HNSW) index for approximate nearest neighbor search.
 * This implementation is based on hierarchical graph navigation to efficiently index and search high-dimensional vectors.
 * A HNSW is basically a multi-dimensional skip list. Each node has (potentially) higher levels that are used for quickly
 * traversing the graph get in the neighborhood of the node, and then lower levels are used to more accurately find the
 * closest neighbors.
 *
 * This implementation is based on the paper "Efficient and Robust Approximate Nearest Neighbor Search in High Dimensions"
 * (mostly influenced AI's contributions)
 */
export class HierarchicalNavigableSmallWorld {
	static useObjectStore = true;
	// Index options that only affect search, not the stored graph — changing them must not trigger a
	// reindex (databases.ts persists the new value but skips rebuilding). efConstructionSearch is the
	// search-time candidate-list size; the build uses efConstruction/M/distance, which are structural.
	// filterExpansion is the visit-budget multiplier for predicate-aware (filtered) traversal.
	// nativePlane never changes the stored CF graph either: enabling it builds the derived plane
	// file by mirroring the existing graph (see getPlane), so a toggle must not force a rebuild.
	static searchOnlyOptions = ['efConstructionSearch', 'filterExpansion', 'nativePlane'];
	// Signals to search.ts that this index accepts a per-record predicate in search() and applies it
	// during traversal (predicate-aware / ACORN-style filtering), so companion conditions and RBAC can
	// be pushed down instead of post-filtering an under-filled candidate set (#1241).
	filteredSearch = true;
	indexStore: any;
	M: number = 16; // max number of connections per layer
	efConstruction: number = 100; // size of dynamic candidate list
	efConstructionSearch: number = 50; // size of dynamic candidate list for search
	mL: number = 1 / Math.log(this.M); // normalization factor for level generation
	// how aggressive do we avoid connections that have alternate indirect routes; a value of 0 never avoids connections,
	// a value of 1 is extremely aggressive.
	optimizeRouting = 0.5;
	nodesVisitedCount = 0;
	// Visit-budget multiplier for predicate-aware traversal (#1241). Under-filled filtered searches
	// stop after the resolved budget ef * filterExpansion visits; automatic search ef contributes at
	// most AUTO_EF_MAX, while explicit schema/query ef remains authoritative. A filter that fills its
	// candidate list terminates naturally before this bound. Raising the multiplier mainly trades
	// latency for recall on selective function predicates; 24 fills to roughly 4% selectivity before
	// the budget binds. Per-query override via the search options.
	filterExpansion = 24;

	idIncrementer: BigInt64Array | undefined;
	distance: (a: number[], b: number[]) => number;
	int8 = true; // store vectors as int8-quantized bins by default; opt out with `quantization: "none"`
	efSearchConfigured = false; // whether the schema pins search ef directly or through efConstruction
	efConstructionConfigured = false; // whether the schema set an explicit efConstruction; if not, it auto-scales with N
	private lastLoggedEfConstruction = 0;
	private idIncrementerRetryAt = 0;
	private idIncrementerFailureLogged = false;
	// Caches the Int8Array-converted clone of a frozen (decoded-from-disk) int8 node, keyed by the
	// frozen node the object store hands back. WeakMap so entries are collected when the store evicts
	// the frozen node — without it, every cache hit on a frozen node would re-slice and re-clone.
	private convertedNodes = new WeakMap<object, any>();
	private nodeCount = 0;
	private nodeCountAt = 0;
	// Native traversal plane (dual-write): the CF graph stays authoritative; every graph mutation
	// is mirrored into the plane file and search runs native when the flag is on.
	// undefined = not yet attached (may retry), null = unavailable or disabled for this process.
	private plane: HnswPlane | null | undefined;
	private planeEligible = false;
	private planeReady = false;
	private planeRetryAt = 0;
	private planeDisabledLogged = false;
	constructor(indexStore: any, options: any) {
		this.indexStore = indexStore;
		if (indexStore) {
			// use float32 representation of numbers as it is twice as space efficient as typical float64 and plenty accurate
			// (we would actually like to use float16 if it were available)
			this.indexStore.encoder.useFloat32 = FLOAT32_OPTIONS.ALWAYS;
		}
		this.int8 = options?.quantization !== 'none';
		// Respect an explicitly-configured ef (efConstruction seeds the search ef too); otherwise auto-scale both.
		this.efSearchConfigured = options?.efConstructionSearch !== undefined || options?.efConstruction !== undefined;
		this.efConstructionConfigured = options?.efConstruction !== undefined;
		this.distance =
			options?.distance === 'euclidean'
				? euclideanDistance
				: options?.distance === 'dotProduct'
					? dotProductDistance
					: cosineDistance;
		if (options) {
			// allow all the HNSW parameters to be configured/tuned
			if (options.M !== undefined) {
				this.M = options.M;
				this.mL = 1 / Math.log(this.M); // recalculate
			}
			if (options.efConstruction !== undefined)
				this.efConstruction = this.efConstructionSearch = options.efConstruction;
			if (options.efConstructionSearch !== undefined) this.efConstructionSearch = options.efConstructionSearch;
			if (options.mL !== undefined) this.mL = options.mL;
			if (options.optimizeRouting !== undefined) this.optimizeRouting = options.optimizeRouting;
			if (options.filterExpansion !== undefined) this.filterExpansion = options.filterExpansion;
		}
		if (options?.nativePlane) {
			// The plane stores int8 bins and computes asymmetric cosine only, so the flag is a
			// no-op for float (quantization: "none") and non-cosine indexes.
			this.planeEligible = this.int8 && this.distance === cosineDistance;
			if (!this.planeEligible) {
				logger.info?.('nativePlane is only supported for int8-quantized cosine HNSW indexes; using the JS search path');
			}
		}
	}

	/** Absolute path of this index's plane file, or undefined when the store exposes no path. */
	planeFilePath(): string | undefined {
		const storePath = this.indexStore?.path;
		const storeName = this.indexStore?.name;
		if (typeof storePath !== 'string' || typeof storeName !== 'string') return undefined;
		return planeFilePathFor(storePath, storeName);
	}

	/**
	 * Attach (open or lazily create) the native plane for this index. `dims` must be provided by
	 * callers that may CREATE the file (a node mirror or a search, which know the vector length);
	 * without it the call is open-only — if no file exists yet there is nothing to sync, and the
	 * eventual creation's full mirror reads the then-current CF state.
	 *
	 * Multi-worker create races are settled by an exclusive open ('wx') of the file itself: the
	 * winner creates and mirrors, losers see EEXIST and open (retrying on a short cadence while
	 * the winner is still writing the header, so their mirror writes drop for at most moments).
	 * A loser attached mid-build mirrors its own writes immediately but planeSearchReady keeps
	 * its searches on the JS path until the builder stamps the mirror complete. A crashed create
	 * leaves an unopenable file; once older than PLANE_STALE_CREATE_MS it is deleted and rebuilt.
	 */
	private getPlane(dims?: number): HnswPlane | null {
		if (this.plane !== undefined) return this.plane;
		if (!this.planeEligible) return (this.plane = null);
		const now = Date.now();
		if (now < this.planeRetryAt) return null;
		const Plane = getPlaneBinding();
		if (!Plane) return (this.plane = null); // the loader warned once already
		const filePath = this.planeFilePath();
		if (!filePath) {
			this.disablePlane(new Error('the index store exposes no path to place the plane file next to'));
			return null;
		}
		try {
			if (existsSync(filePath)) {
				try {
					return (this.plane = Plane.open(filePath));
				} catch (openError) {
					if (now - statSync(filePath).mtimeMs <= PLANE_STALE_CREATE_MS) {
						// another worker is between its exclusive create and the header write
						this.planeRetryAt = now + PLANE_ATTACH_RETRY_MS;
						return null;
					}
					logger.warn?.('deleting an unopenable HNSW plane file left by an interrupted create', openError);
					unlinkSync(filePath);
					// fall through to the create path below
				}
			}
			if (!dims) return null; // open-only call and no file: nothing to attach yet
			let fd: number;
			try {
				fd = openSync(filePath, 'wx');
			} catch {
				// another worker won the create race; its header lands within moments
				this.planeRetryAt = now + PLANE_ATTACH_RETRY_MS;
				return null;
			}
			closeSync(fd);
			// a populated graph's own dimensionality sizes the file — a caller-supplied dims
			// (possibly a malformed search target) must not; the file format pins dims forever
			for (const { value } of this.indexStore.getRange({ start: 0, end: Infinity, limit: 1 })) {
				const storedVector = value?.level !== undefined ? value.vector : undefined;
				if (storedVector) dims = Array.isArray(storedVector) ? storedVector.length : storedVector.byteLength;
			}
			try {
				return (this.plane = this.createAndMirrorPlane(Plane, filePath, dims));
			} catch (createError) {
				// never leave a file a later open would trust as a complete mirror
				try {
					unlinkSync(filePath);
				} catch {
					// the disable below already forces the JS path for this process
				}
				this.disablePlane(createError);
				return null;
			}
		} catch (error) {
			this.planeRetryAt = now + NODE_COUNT_TTL;
			logger.warn?.('could not attach the HNSW plane file; will retry', error);
			return null;
		}
	}

	/**
	 * True once the plane's initial full mirror completed (watermark stamped nonzero at the end
	 * of createAndMirrorPlane). A plane opened mid-build keeps receiving this worker's mirror
	 * writes but must not serve searches — its graph is incomplete; one abandoned by a crashed
	 * builder would stay unusable forever, so past a generous age it is rebuilt from the CF.
	 */
	private planeSearchReady(plane: HnswPlane): boolean {
		if (this.planeReady) return true;
		if (plane.getWatermark() >= PLANE_MIRRORED) {
			this.planeReady = true;
			return true;
		}
		const filePath = this.planeFilePath();
		if (filePath) {
			try {
				// age by creation time: ongoing dual-writes into an abandoned build keep
				// refreshing mtime, which would defer this rebuild forever
				const stat = statSync(filePath);
				if (Date.now() - (stat.birthtimeMs || stat.mtimeMs) > PLANE_INCOMPLETE_REBUILD_MS) {
					logger.warn?.('rebuilding an HNSW plane file whose initial mirror never completed');
					this.resetDerivedStorage();
				}
			} catch {
				// stat raced a concurrent delete; the next attach sorts it out
			}
		}
		return false;
	}

	/**
	 * Create the plane file and fully mirror the existing CF graph into it (the "first enable"
	 * build — a pure copy of the same graph, so plane and CF are bit-identical by construction;
	 * a reindex would rebuild a different random-level graph at far higher cost). The scan reads
	 * committed state: mutations committed while it runs mirror themselves through their own
	 * dual-write calls, though a write racing the scan can transiently be overwritten with the
	 * scan's older snapshot of that node — it re-syncs on the node's next touch, and the exact
	 * rescore + record load already filter stale candidates (relaxed adherence, design §5).
	 */
	private createAndMirrorPlane(
		Plane: NonNullable<ReturnType<typeof getPlaneBinding>>,
		filePath: string,
		dims: number
	): HnswPlane {
		// derived from M/optimizeRouting like the JS layer-0 cap, so a non-default M gets a
		// matching slot geometry rather than silent truncation to a fixed width
		const layer0Cap = Math.min(PLANE_LAYER0_CAP_MAX, this.optimizeRouting ? this.M << 3 : this.M << 1);
		const plane = Plane.create(filePath, dims, layer0Cap, PLANE_MAX_NODES);
		let mirrored = 0;
		for (const { key, value } of this.indexStore.getRange({ start: 0, end: Infinity })) {
			if (typeof key !== 'number' || !value || value.level === undefined) continue;
			this.writeNodeToPlane(plane, key, value);
			mirrored++;
		}
		const entryPointId = this.indexStore.getSync(ENTRY_POINT);
		if (typeof entryPointId === 'number') {
			plane.setEntryPoint(entryPointId, this.safeGetSync(entryPointId)?.level ?? 0);
		}
		// stamped last: a crash or thrown mirror error leaves the watermark 0, and
		// planeSearchReady refuses to serve searches from a mirror that never completed
		plane.setWatermark(PLANE_MIRRORED);
		// one msync so the completed mirror (and its watermark) is durable; steady-state
		// flush cadence is a recorded phase-2 open item
		plane.flush();
		this.planeReady = true;
		if (mirrored > 0) logger.info?.(`built the HNSW plane file from ${mirrored} existing graph nodes`);
		return plane;
	}

	/** Write one JS graph node's full state into the plane (throws on ineligible node state). */
	private writeNodeToPlane(plane: HnswPlane, nodeId: number, node: any): void {
		if (!Number.isInteger(nodeId) || nodeId < 0 || nodeId >= PLANE_NO_ID) {
			throw new Error(`node id ${nodeId} is outside the plane's u32 id space`);
		}
		const vector = node.vector;
		let bin: Buffer;
		let scale: number;
		let invMag: number | undefined = node.invMag;
		if (Array.isArray(vector)) {
			// legacy float node inside an int8 index: quantize the mirror copy only (the CF node
			// is untouched); its distances in the plane are then quantized like every other node
			const q = quantizeInt8(vector);
			bin = q.bytes;
			scale = q.scale;
			if (invMag === undefined) {
				let magSq = 0;
				for (const v of vector) magSq += v * v;
				invMag = 1 / (Math.sqrt(magSq) || 1);
			}
		} else {
			// Int8Array (converted) or raw bin view straight from the store decode — same bytes;
			// pass them through untouched (never re-quantize)
			bin = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
			scale = node.scale ?? 1;
			if (invMag === undefined) {
				// legacy pre-invMag node: |v| ~= scale * |q|, the same fallback searchLayer uses
				const q =
					vector instanceof Int8Array ? vector : new Int8Array(vector.buffer, vector.byteOffset, vector.byteLength);
				let magSq = 0;
				for (let i = 0; i < q.length; i++) magSq += q[i] * q[i];
				invMag = 1 / ((Math.sqrt(magSq) || 1) * scale);
			}
		}
		const level = node.level ?? 0;
		const layer0 = planeConnectionIds(node[0], plane.layer0Cap);
		let upper: Uint32Array[] | null = null;
		if (level >= 1) {
			upper = [];
			for (let l = 1; l <= level; l++) upper.push(planeConnectionIds(node[l], PLANE_UPPER_CAP));
		}
		plane.writeNodeRaw(nodeId, level, bin, scale, invMag, layer0, upper);
	}

	/** Mirror a node put into the plane; a plane failure never fails the CF write. */
	private mirrorNodePut(nodeId: number, node: any): void {
		if (!this.planeEligible) return;
		const vector = node?.vector;
		const dims = Array.isArray(vector) ? vector.length : vector?.byteLength;
		const plane = this.getPlane(dims);
		if (!plane) return;
		try {
			this.writeNodeToPlane(plane, nodeId, node);
		} catch (error) {
			this.disablePlane(error);
		}
	}

	private mirrorNodeRemove(nodeId: number): void {
		if (!this.planeEligible) return;
		const plane = this.getPlane();
		if (!plane) return;
		try {
			plane.clearNode(nodeId);
		} catch (error) {
			this.disablePlane(error);
		}
	}

	private mirrorEntryPoint(entryPointId: number, level: number | undefined, options?: any): void {
		if (!this.planeEligible) return;
		const plane = this.getPlane();
		if (!plane) return;
		try {
			plane.setEntryPoint(entryPointId, level ?? this.safeGetSync(entryPointId, options)?.level ?? 0);
		} catch (error) {
			this.disablePlane(error);
		}
	}

	private mirrorEntryPointCleared(): void {
		if (!this.planeEligible) return;
		const plane = this.getPlane();
		if (!plane) return;
		try {
			plane.setEntryPoint(PLANE_NO_ID, 0);
		} catch (error) {
			this.disablePlane(error);
		}
	}

	/**
	 * Disable the plane for this process; searches and writes fall back to the JS/CF path. The
	 * file is deleted too: dual-write stops here, so a mirror kept on disk would be reopened
	 * after a restart missing every post-disable mutation. Another worker still mapping the old
	 * inode keeps itself consistent until the schema-change/restart cycle rebuilds everything.
	 */
	private disablePlane(error: unknown): void {
		this.plane = null;
		this.planeReady = false;
		const filePath = this.planeFilePath();
		if (filePath) {
			try {
				unlinkSync(filePath);
			} catch (unlinkError: any) {
				if (unlinkError?.code !== 'ENOENT') logger.warn?.('could not delete the disabled HNSW plane file', unlinkError);
			}
		}
		if (!this.planeDisabledLogged) {
			this.planeDisabledLogged = true;
			logger.error?.('disabling the HNSW native plane for this index (falling back to the JS path)', error);
		}
	}

	/**
	 * Delete the derived plane state. Called when the backing store is dropped or cleared
	 * (index drop, table drop/clear, reindex-from-scratch); the plane lazily rebuilds from the
	 * CF on next use. Unlinking while another worker still maps the old file is safe on POSIX —
	 * that worker keeps writing the orphaned inode until the schema-change signal resets its
	 * database instances.
	 */
	resetDerivedStorage(): void {
		this.plane = undefined;
		this.planeReady = false;
		this.planeRetryAt = 0;
		const filePath = this.planeFilePath();
		if (!filePath) return;
		try {
			unlinkSync(filePath);
		} catch (error: any) {
			if (error?.code !== 'ENOENT') {
				// a stale file that cannot be deleted (e.g. Windows EBUSY while mapped) must not
				// be reopened as if current — keep the plane disabled for this process instead
				this.plane = null;
				logger.warn?.('could not delete the HNSW plane file', error);
			}
		}
	}

	/**
	 * Native search over the plane: one NAPI crossing, traversal on the libuv pool, promise
	 * resolution maps node ids back to primary keys through the existing pk resolution. The
	 * predicate adapter runs on this thread's event loop (batched over a ThreadsafeFunction), so
	 * this promise must never be awaited by code the predicate itself blocks on; the normal
	 * request path awaits it safely.
	 */
	private searchPlane(
		plane: HnswPlane,
		target: number[],
		ef: number,
		filter: ((primaryKey: Id) => boolean) | undefined,
		filterState: FilterState | undefined,
		options: any
	): Promise<any[]> {
		const query = Float32Array.from(target);
		let resultPromise: Promise<{ id: number; distance: number }[]>;
		let predicateError: unknown;
		if (filter && filterState) {
			const predicate = (ids: number[]): Uint8Array => {
				const verdicts = new Uint8Array(ids.length);
				if (predicateError !== undefined) return verdicts; // already failed — deny remaining batches cheaply
				try {
					for (let i = 0; i < ids.length; i++) {
						const primaryKey = this.safeGetSync(ids[i], options)?.primaryKey;
						if (primaryKey !== undefined && this.admit(filter, filterState, primaryKey)) verdicts[i] = 1;
					}
				} catch (error) {
					// an app-supplied filter threw: deny the batch and surface the error once the
					// traversal resolves — the same query failure the JS path raises — instead of
					// letting it escape into the fatal-strategy ThreadsafeFunction callback
					predicateError ??= error;
				}
				return verdicts;
			};
			// pass the already-resolved JS visit budget verbatim so both paths stop at the same count
			resultPromise = plane.searchWithPredicate(query, ef, ef, predicate, undefined, filterState.maxVisits);
		} else {
			resultPromise = plane.search(query, ef, ef);
		}
		return resultPromise.then((hits) => {
			if (predicateError !== undefined) {
				// the plane itself is healthy; mark the failure as the application's so the caller
				// re-raises it rather than disabling the plane and retrying
				try {
					(predicateError as any)[PLANE_PREDICATE_ERROR] = true;
				} catch {
					// a frozen/primitive throw still propagates, it just also disables the plane
				}
				throw predicateError;
			}
			const entries: any[] = [];
			for (const hit of hits) {
				const primaryKey = this.safeGetSync(hit.id, options)?.primaryKey;
				if (primaryKey === undefined) continue; // deleted/reused id raced the search
				entries.push({ key: primaryKey, distance: hit.distance });
			}
			// nodesVisited stays 0 here: layer-0 visits happen inside the native traversal
			// (filterEvaluations is still counted by the predicate adapter)
			return withStats(entries, filterState);
		});
	}

	index(primaryKey: Id, vector: number[], existingVector?: number[], options: any = {}) {
		// Reject non-finite components before touching the graph. NaN in particular poisons
		// bisectInsert (arr[mid].distance <= NaN is always false → returns 0, pinning the
		// candidate to rank 1 of every future search). Infinity causes analogous ordering
		// anomalies. embedHook.ts intentionally passes NaN through and expects HNSW to guard.
		if (vector) {
			for (let i = 0; i < vector.length; i++) {
				if (!Number.isFinite(vector[i])) {
					throw new ClientError(
						`Vector for attribute "${String(primaryKey)}" contains non-finite component at index ${i}: ${vector[i]}. Ensure the embedding produces only finite values.`
					);
				}
			}
		}
		// first get the node id for the primary key; we use internal node ids for better efficiency,
		// but we must use a safe key that won't collide with the node ids
		const safeKey = typeof primaryKey === 'number' ? [KEY_PREFIX, primaryKey] : primaryKey;
		let nodeId = this.indexStore.getSync(safeKey, options);
		// if the node id is not found, create a new node (and store it in the index store)
		// (note that we don't need to check if the node id is already in the index store,
		// because we use internal node ids for better efficiency, and we use a safe key
		// that won't collide with the node ids, so we can't have a collision with internal
		if (!nodeId) {
			if (!vector) return; // didn't exist before, doesn't exist now, nothing to do
			this.ensureIdIncrementer(options);
			nodeId = Number(Atomics.add(this.idIncrementer!, 0, 1n));
			this.indexStore.put(safeKey, nodeId, options);
		}
		const updatedNodes = new Map<number, Node>();
		let oldNode: Node;
		// If this is the first entry, create it as the entry point
		let entryPointId = this.indexStore.getSync(ENTRY_POINT, options);
		if (existingVector) {
			// If we are updating an existing entry, we need to update the entry point
			// if the new entry is closer to the entry point than the old one
			oldNode = { ...this.safeGetSync(nodeId, options) };
		} else {
			// If this key already has a graph node — which happens
			// when runIndexing re-feeds an already-indexed record after a crash/restart — load it
			// and treat the call as an update rather than a fresh insert. Without this, the absent
			// existingVector causes oldNode = {} → a new random level, connections overwritten,
			// and old-connection cleanup skipped, leaving dangling reverse edges and wrong levels.
			const storedNode = nodeId && vector ? this.safeGetSync(nodeId, options) : undefined;
			if (storedNode && storedNode.level !== undefined) {
				// Treat as an update: carry forward the stored graph state so cleanup and level
				// assignment below use the real existing connections instead of starting fresh.
				oldNode = { ...storedNode };
				// Reconstruct the existingVector from the stored node so distance computations
				// in the cleanup pass use the right baseline (dequantize if int8).
				if (!existingVector) {
					existingVector =
						storedNode.scale !== undefined
							? dequantizeInt8(storedNode.vector as Int8Array, storedNode.scale)
							: (storedNode.vector as number[]);
				}
			} else {
				oldNode = {} as Node;
			}
		}
		if (vector) {
			// Pre-compute 1/|vector| for cosine distance so searchLayer can skip sqrt per neighbor
			let invMag: number | undefined;
			if (this.distance === cosineDistance) {
				let magSq = 0;
				for (const v of vector) magSq += v * v;
				invMag = 1 / (Math.sqrt(magSq) || 1);
			}
			// Quantized storage form. The float `vector` is still used as the query for every
			// searchLayer call below (asymmetric distance: float query x int8 stored); only what
			// we PUT to the store is quantized.
			const q = this.int8 ? quantizeInt8(vector) : undefined;
			const storedVector: number[] | Buffer = q ? q.bytes : vector;
			const storedScale = q ? q.scale : undefined;
			let entryPoint = entryPointId && this.safeGetSync(entryPointId, options);
			if (entryPoint == null) {
				const level = Math.floor(-Math.log(Math.random()) * this.mL);
				const node = {
					vector: storedVector,
					scale: storedScale,
					invMag,
					level,
					primaryKey,
				};
				for (let i = 0; i <= level; i++) {
					node[i] = [];
				}
				this.indexStore.put(nodeId, node, options);
				if (typeof nodeId !== 'number') {
					throw new Error('Invalid nodeId: ' + nodeId);
				}
				logger.debug?.('setting entry point to', nodeId);
				this.indexStore.put(ENTRY_POINT, nodeId, options);
				this.mirrorNodePut(nodeId, node);
				this.mirrorEntryPoint(nodeId, level, options);
				return;
			}

			// Generate random level for this new element
			const level = oldNode.level ?? Math.min(Math.floor(-Math.log(Math.random()) * this.mL), MAX_LEVEL);
			let currentLevel = entryPoint.level;
			let mirrorEntryPointAfterPut = false;
			if (level > currentLevel) {
				// if we are at a higher level, make this the new entry point
				if (typeof nodeId !== 'number') {
					throw new Error('Invalid nodeId: ' + nodeId);
				}
				logger.debug?.('setting entry point to', nodeId);
				this.indexStore.put(ENTRY_POINT, nodeId, options);
				// the CF put is invisible until commit, but a plane write is immediately visible —
				// mirror the promotion only after the node's own slot lands (below), so a concurrent
				// native search never descends from a not-yet-written entry slot
				mirrorEntryPointAfterPut = true;
			}

			// Pure descent — only neighbors[0] is used — so it runs greedily for the same reason
			// search() does. The connection-building pass below keeps efConstruction: it selects the
			// edges that get stored.
			while (currentLevel > level) {
				// Search for closest neighbors at current level
				const neighbors = this.searchLayer(vector, entryPointId, entryPoint, ROUTING_EF, currentLevel, options);

				if (neighbors.length > 0) {
					entryPointId = neighbors[0].id; // closest neighbor becomes new entry point
					entryPoint = neighbors[0].node;
				}
				currentLevel--;
			}
			const connections = new Array(level + 1);
			for (let i = 0; i <= level; i++) {
				connections[i] = [];
			}

			// An update-only worker may not have attached the id counter yet. The healthy path is one
			// atomic load; a failed attach falls back to the memoized seek and retries after its TTL.
			let efConstruction = this.efConstruction;
			if (!this.efConstructionConfigured) {
				// Graph size only tunes a heuristic; a write must never fail because it could not be resolved.
				try {
					efConstruction = autoScaleEfConstruction(this.resolveConstructionNodeCount(options));
				} catch (error) {
					logger.debug?.('could not resolve the HNSW construction node count; using the base ef', error);
				}
				if (efConstruction > this.efConstruction && this.lastLoggedEfConstruction !== efConstruction) {
					// once per resolved value per process: makes replica-divergent build quality and the
					// build-cost ramp diagnosable (the resolved value is otherwise surfaced nowhere)
					this.lastLoggedEfConstruction = efConstruction;
					logger.debug?.(`HNSW construction ef auto-scaled to ${efConstruction}`);
				}
			}
			for (let l = Math.min(level, currentLevel); l >= 0; l--) {
				let neighbors = this.searchLayer(vector, entryPointId, entryPoint, efConstruction, l, options);
				neighbors = neighbors.slice(0, this.M << 1) as SearchResults;

				if (neighbors.length === 0 && l === 0) {
					logger.info?.('should not have zero connections for', entryPointId);
				}
				const connectionsAtLevel = connections[l];
				// Create bidirectional connections
				for (let i = 0; i < neighbors.length; i++) {
					const { id, distance, node } = neighbors[i];
					if (id === nodeId) continue; // don't connect to self
					const connectionsToBeReplaced: { fromId: number; toId: number }[] = [];
					if (this.optimizeRouting) {
						// if we have existing connections through other nodes, we deprioritize new connections through them.
						// I believe this yields better HNSW graphs, avoiding redundant paths, with better directed connectivity
						// towards desired results
						let skipping = false;
						const neighborNeighbors = node[l];
						const distanceThreshold = 1 + this.optimizeRouting * (1 + (0.5 * i) / this.M);
						for (let i2 = 0; i2 < neighborNeighbors?.length; i2++) {
							const { id: neighborId, distance: neighborDistance } = neighborNeighbors[i2];
							const neighborDistanceThreshold = 1 + this.optimizeRouting * (1 + (0.5 * i2) / this.M);
							for (let i3 = 0; i3 < connectionsAtLevel.length; i3++) {
								const { id: addedId, distance: addedDistance } = connectionsAtLevel[i3];
								if (addedId === neighborId) {
									if (distance * distanceThreshold > addedDistance + neighborDistance) {
										// if the new distance is relatively low compared to existing indirect connections,
										// we skip this neighbor since it is of less value
										skipping = true;
									} else if (neighborDistance * neighborDistanceThreshold > distance + addedDistance) {
										// potentially remove the neighbor's neighbor, because we are adding a better route (if we do add it)
										connectionsToBeReplaced.push({ fromId: addedId, toId: id });
										connectionsToBeReplaced.push({ fromId: id, toId: addedId });
									}
									break;
								}
							}
							if (skipping) break;
						}
						if (skipping) continue;
					} else if (i >= (l > 0 ? this.M : this.M << 1)) {
						// fallback to traditional HNSW level limiting; if we are at the maximum number of neighbors, we skip this one
						continue;
					}
					// Add connection to the new element
					connectionsAtLevel.push({ id, distance });

					for (const { fromId, toId } of connectionsToBeReplaced) {
						let from = updateNode(fromId);
						if (!from) from = updateNode(fromId, this.safeGetSync(fromId, options));
						if (!from) continue;
						const fromAtLevel = from[l];
						if (!fromAtLevel) continue;
						for (let i = 0; i < fromAtLevel.length; i++) {
							if (from[l][i].id === toId) {
								if (Object.isFrozen(from[l])) {
									from[l] = from[l].slice();
								}
								from[l].splice(i, 1);
								break;
							}
						}
					}

					// Add reverse connection from neighbor to new element if it didn't exist before
					// First check to see if we had an existing neighbor connection before. If we did we can
					// just remove from the list of the connections to remove (don't remove, leave it in place)
					let oldConnections = oldNode[l] as WithCopied;
					const oldConnection = oldConnections?.find(({ id: nid }) => nid === id);
					if (oldConnection) {
						const oldPosition = oldConnections?.indexOf(oldConnection);
						if (!oldConnections.copied) {
							// make a copy, it is likely frozen
							oldConnections = [...oldConnections] as WithCopied;
							oldConnections.copied = true;
							oldNode[l] = oldConnections;
						}
						oldConnections.splice(oldPosition, 1);
						// update the distance in the reverse connection if the vector changed
						if (oldConnection.distance !== distance) {
							const neighborNode = updateNode(id, node);
							if (neighborNode[l]) {
								if (Object.isFrozen(neighborNode[l])) {
									neighborNode[l] = neighborNode[l].slice();
								}
								const reverseIdx = neighborNode[l].findIndex(({ id: nid }) => nid === nodeId);
								if (reverseIdx >= 0) {
									neighborNode[l][reverseIdx] = { id: nodeId, distance };
								}
							}
						}
					} else {
						// add new connection since this is truly a new connection now
						this.addConnection(id, updateNode(id, node), nodeId, l, distance, updateNode, options);
					}
				}
			}

			// Store the new element
			const storedNode = {
				vector: storedVector,
				scale: storedScale,
				invMag,
				level,
				primaryKey,
				...connections,
			};
			this.indexStore.put(nodeId, storedNode, options);
			this.mirrorNodePut(nodeId, storedNode);
			if (mirrorEntryPointAfterPut) this.mirrorEntryPoint(nodeId, level, options);
		} else {
			// removal of this node, but first make sure we have a valid entry point
			if (entryPointId === nodeId) {
				// if this is the entry point, find a new entry point
				const lastLevel = oldNode.level ?? 0;
				for (let l = lastLevel; l >= 0; l--) {
					entryPointId = oldNode[l]?.[0]?.id;
					if (entryPointId !== undefined) break;
				}
				if (entryPointId === undefined) {
					// Fallback scan: pass transaction so it sees the same write-set (not stale committed state),
					// skip the node being deleted (it is typically the highest-level node and would be
					// re-elected), and verify each candidate actually resolves before committing it.
					let highestLevel = -1;
					for (const { key, value } of this.indexStore.getRange({
						start: 0,
						end: Infinity,
						transaction: options.transaction,
					})) {
						// skip the node being removed (safeKey mappings can't appear here: symbol-array
						// and string keys sort outside the numeric 0..Infinity range)
						if (key === nodeId) continue;
						if (!value || value.level === undefined) continue;
						if (value.level > highestLevel) {
							entryPointId = key;
							if (value.level === lastLevel) break; // found a node at the same level as the old entry point
							highestLevel = value.level;
						}
					}
				}
				if (entryPointId === undefined) {
					// no nodes left in index
					this.indexStore.remove(ENTRY_POINT, options);
					this.mirrorEntryPointCleared();
				} else {
					// set the new entry point
					if (typeof entryPointId !== 'number') {
						throw new Error('Invalid nodeId: ' + entryPointId);
					}
					logger.debug?.('setting entry point to', entryPointId);
					this.indexStore.put(ENTRY_POINT, entryPointId, options);
					this.mirrorEntryPoint(entryPointId, undefined, options);
				}
			}
			this.indexStore.remove(nodeId, options);
			this.mirrorNodeRemove(nodeId);
			// A re-insert of this primary key must get a fresh node rather than the deleted node's id.
			this.indexStore.remove(safeKey, options);
		}
		const needsReindexing = new Map();
		// On DELETE, track every neighbor that loses an edge: the empty-list check below only
		// catches fully-orphaned nodes, but a cluster can stay internally connected while losing
		// its only bridges to the entry point — see repairSeveredNeighbors (#1712).
		const edgeLosingNeighborIds = vector ? undefined : new Set<number>();
		// remove connections to this node that are no longer valid
		if (oldNode.level !== undefined) {
			for (let l = 0; l <= oldNode.level; l++) {
				const oldConnections = oldNode[l];
				for (const { id: neighborId } of oldConnections) {
					// get and copy the neighbor node so we can modify it
					const neighborNode = updateNode(neighborId, this.safeGetSync(neighborId, options));
					if (!neighborNode) continue;
					edgeLosingNeighborIds?.add(neighborId);
					// On an UPDATE (vector != null), only remove the reverse edge at
					// the exact level l where the old connection existed. Sweeping 0..l would destroy reverse
					// edges at lower levels that were just re-added by addConnection or preserved by the
					// splice logic above — causing asymmetry that accumulates with every re-embed.
					// On DELETE (vector == null), the full 0..l sweep is correct: we want to remove every
					// occurrence of nodeId from all levels of each neighbor.
					const levelStart = vector ? l : 0;
					for (let l2 = levelStart; l2 <= l; l2++) {
						// remove the connection to this node from the neighbor node
						neighborNode[l2] = neighborNode[l2]?.filter(({ id: nid }) => {
							return nid !== nodeId;
						});
						if (neighborNode[l2]?.length === 0) {
							logger.trace?.('node was left orphaned, will reindex', neighborId);
							// reindex re-feeds this vector into index() as a float query, so dequantize int8 back to float
							needsReindexing.set(
								neighborNode.primaryKey,
								neighborNode.scale !== undefined
									? dequantizeInt8(neighborNode.vector as Int8Array, neighborNode.scale)
									: neighborNode.vector
							);
						}
					}
				}
			}
		}
		function updateNode(id: number, node?: Node) {
			// keep a record of all our changes, maintaining any changes that are queued to be written
			let updatedNode: Node = updatedNodes.get(id);
			if (!updatedNode && node) {
				// copy the node so we can modify it
				updatedNode = { ...node };
				updatedNodes.set(id, updatedNode);
			}
			return updatedNode;
		}
		for (const [id, updatedNode] of updatedNodes) {
			this.indexStore.put(id, updatedNode, options);
			this.mirrorNodePut(id, updatedNode);
		}
		for (const [key, orphanVector] of needsReindexing) {
			// If the orphan IS the current entry point, re-running
			// index() from it would find no other nodes to connect to (the entry point search returns
			// itself), leaving it permanently isolated. Elect a surviving neighbor as entry point first
			// so the orphan can reconnect to the live graph.
			const currentEP = this.indexStore.getSync(ENTRY_POINT, options);
			const orphanNodeId = this.indexStore.getSync(typeof key === 'number' ? [KEY_PREFIX, key] : key, options);
			if (currentEP !== undefined && currentEP === orphanNodeId) {
				// The orphan's own connection lists are empty, so look for a surviving node to elect:
				// first among the nodes updated in this pass, then a full scan as fallback.
				let replacementEP: number | undefined;
				for (const [candidateId, candidateNode] of updatedNodes) {
					if (candidateId !== orphanNodeId && candidateNode[0]?.length > 0) {
						replacementEP = candidateId;
						break;
					}
				}
				if (replacementEP === undefined) {
					for (const { key: candidateKey, value: candidateNode } of this.indexStore.getRange({
						start: 0,
						end: Infinity,
						transaction: options.transaction,
					})) {
						if (candidateKey === orphanNodeId) continue;
						if (candidateNode?.level !== undefined) {
							replacementEP = candidateKey;
							break;
						}
					}
				}
				if (replacementEP !== undefined) {
					this.indexStore.put(ENTRY_POINT, replacementEP, options);
					this.mirrorEntryPoint(replacementEP, undefined, options);
				}
			}
			this.index(key, orphanVector, orphanVector, options);
		}
		if (edgeLosingNeighborIds?.size) this.repairSeveredNeighbors(edgeLosingNeighborIds, options);
		this.checkSymmetry(nodeId, this.safeGetSync(nodeId, options), options);
	}

	/**
	 * After a delete, a neighbor that lost an edge can be severed from the entry point even with
	 * non-empty connection lists: a locally-connected cluster whose only bridges ran through the
	 * deleted node becomes a disconnected island, unreachable by search at any ef (#1712). The
	 * empty-list orphan check in index() can't see this, so probe each edge-losing neighbor's
	 * connectivity and reindex the ones that are cut off.
	 *
	 * The probe is a level-prioritized best-first traversal (hubs first, since the entry point is
	 * a high-level node), treating edges as undirected — the same assumption validateConnectivity
	 * makes. Note the direction difference: the probe walks source→entry-point over stored
	 * (outgoing) edges while search walks entry-point→outward, so an asymmetric edge could make
	 * the probe claim connectivity that search doesn't have. Edges are bidirectional by
	 * construction (checkSymmetry logs violations), and reverse-reachability from the entry point
	 * would be O(N) per delete, so this is a deliberate residual. In a connected component the
	 * probe reaches the known-connected set within a few hops; in an island it exhausts the
	 * island quickly. If it exceeds PROBE_VISIT_LIMIT without an answer (pathologically distant
	 * entry point — or an island larger than the budget), reinsert just the probe source: a
	 * wasted reinsert in the connected case, and in the oversized-island case a partial repair
	 * (the source relinks to the live graph, the rest of the island stays severed — reindexing
	 * replaces the source's edges rather than bridging through them, and reindexing all 256+
	 * probed nodes on what is usually just a distant entry point would be far too expensive).
	 */
	private repairSeveredNeighbors(neighborIds: Set<number>, options: any) {
		const entryPointId = this.indexStore.getSync(ENTRY_POINT, options);
		if (entryPointId === undefined) return;
		const knownConnected = new Set<number>([entryPointId]);
		for (const sourceId of neighborIds) {
			if (knownConnected.has(sourceId)) continue;
			const sourceNode = this.safeGetSync(sourceId, options);
			if (!sourceNode || sourceNode.level === undefined) continue; // already removed or stale reference
			const visited = new Map<number, Node>([[sourceId, sourceNode]]);
			const frontier = new MinHeap();
			frontier.push({ id: sourceId, distance: -sourceNode.level, node: sourceNode });
			let verdict: 'connected' | 'island' | 'inconclusive' = 'island';
			probe: for (;;) {
				const current = frontier.pop();
				if (!current) break; // exhausted the reachable set without touching the connected component
				for (let l = 0; l <= current.node.level; l++) {
					for (const { id: neighborId } of current.node[l] || []) {
						if (neighborId === undefined) continue;
						if (knownConnected.has(neighborId)) {
							verdict = 'connected';
							break probe;
						}
						if (visited.has(neighborId)) continue;
						const node = this.safeGetSync(neighborId, options);
						if (!node || node.level === undefined) continue; // stale reference
						visited.set(neighborId, node);
						frontier.push({ id: neighborId, distance: -node.level, node });
					}
				}
				if (visited.size > PROBE_VISIT_LIMIT) {
					verdict = 'inconclusive';
					break;
				}
			}
			if (verdict === 'connected') {
				// every visited node connects to the source, which reaches the connected component
				for (const id of visited.keys()) knownConnected.add(id);
			} else {
				// island: reinsert every member so the whole cluster relinks to the live graph;
				// inconclusive: reinsert only the source (partial repair — see docstring)
				if (verdict === 'inconclusive') {
					logger.warn?.('connectivity probe exceeded visit budget after a delete, reinserting only', sourceId);
				}
				const toReindex = verdict === 'island' ? visited.values() : [sourceNode];
				logger.debug?.('reindexing nodes severed from the entry point by a delete', sourceId);
				for (const node of toReindex) {
					const nodeVector =
						node.scale !== undefined ? dequantizeInt8(node.vector as Int8Array, node.scale) : (node.vector as number[]);
					this.index(node.primaryKey, nodeVector, nodeVector, options);
				}
				if (verdict === 'island') {
					// the whole reindexed island is now relinked; skip re-probing its members
					for (const id of visited.keys()) knownConnected.add(id);
				} else {
					knownConnected.add(sourceId);
				}
			}
		}
	}

	/**
	 * Number of nodes in the graph, for the ef auto-scale. Must stay O(1): it runs per query, and an
	 * exact count is a full key scan. RocksDB's `estimate-num-keys` is not a usable substitute — it
	 * counts unreconciled overwrites, which graph construction produces in bulk. See DESIGN.md for the
	 * measurements behind both. The memo is the only gate on how often the size is resolved; nothing on
	 * the query path may bypass it, or the O(1) lookup becomes per-query work again.
	 */
	private approximateNodeCount(options?: any): number {
		const now = Date.now();
		if (this.nodeCountAt > 0 && now - this.nodeCountAt < NODE_COUNT_TTL) return this.nodeCount;
		this.nodeCount = this.resolveNodeCount(options);
		this.nodeCountAt = now;
		return this.nodeCount;
	}

	private resolveConstructionNodeCount(options?: any): number {
		if (this.idIncrementer) return this.resolveNodeCount();
		const now = Date.now();
		if (now >= this.idIncrementerRetryAt) {
			try {
				this.ensureIdIncrementer(options);
				this.idIncrementerRetryAt = 0;
				this.idIncrementerFailureLogged = false;
				return this.resolveNodeCount();
			} catch (error) {
				this.idIncrementerRetryAt = now + NODE_COUNT_TTL;
				if (!this.idIncrementerFailureLogged) {
					this.idIncrementerFailureLogged = true;
					logger.warn?.('could not attach the shared HNSW id counter; using a memoized node count', error);
				}
			}
		}
		return this.approximateNodeCount(options);
	}

	/**
	 * Create-or-attach the shared id counter, seeded from a one-time reverse seek to the largest node
	 * id. getUserSharedBuffer returns the existing shared buffer when another worker created it
	 * first, so the seed only matters for whoever wins the race.
	 */
	private ensureIdIncrementer(options?: any): void {
		if (this.idIncrementer) return;
		let largestNodeId = 0;
		for (const key of this.indexStore.getKeys({
			reverse: true,
			limit: 1,
			start: Infinity,
			end: 0,
			transaction: options?.transaction,
		})) {
			if (typeof key === 'number') largestNodeId = key;
		}
		// Never install the counter until the shared attach succeeds: assigning the private seed
		// array first would, on an attach failure, leave THIS process allocating ids nobody else can
		// see — cross-worker id collisions. Left unset, the next write simply retries the ensure.
		const seed = new BigInt64Array([BigInt(largestNodeId) + 1n]);
		try {
			const sharedBuffer = this.indexStore.getUserSharedBuffer('next-id', seed.buffer);
			if (
				!sharedBuffer ||
				sharedBuffer.byteLength < BigInt64Array.BYTES_PER_ELEMENT ||
				sharedBuffer.byteLength % BigInt64Array.BYTES_PER_ELEMENT !== 0
			) {
				throw new Error('Shared HNSW id counter buffer is unusable');
			}
			this.idIncrementer = new BigInt64Array(sharedBuffer);
		} catch (error) {
			// Reuse the transactional seed seek as the degraded count instead of seeking a second time.
			this.nodeCount = largestNodeId + 1;
			this.nodeCountAt = Date.now();
			throw error;
		}
	}

	/** O(1) node count — the shared id counter, else a single reverse seek to the largest node id. */
	private resolveNodeCount(options?: any): number {
		if (this.idIncrementer) return Number(Atomics.load(this.idIncrementer, 0));
		try {
			for (const key of this.indexStore.getKeys({
				reverse: true,
				limit: 1,
				start: Infinity,
				end: 0,
				transaction: options?.transaction,
			})) {
				if (typeof key === 'number') return key + 1;
			}
		} catch (error) {
			logger.debug?.('could not resolve node count from the largest node id', error);
		}
		return 0; // empty (or unreadable) graph — autoScaleEf falls back to its floor
	}

	private safeGetSync(key: any, options?: any): any {
		try {
			let node = this.indexStore.getSync(key, options);
			// A quantized vector decodes as a bin (Uint8Array/Buffer) that is a view into the
			// store's read buffer, which may be reused on the next getSync — so copy the bytes
			// into a retained Int8Array (raw two's-complement reinterpret). The Int8Array guard
			// skips re-conversion when the object store (useObjectStore) hands back an
			// already-converted cached node. Float nodes (vector is a number[]) pass through.
			if (node && node.vector && !Array.isArray(node.vector) && !(node.vector instanceof Int8Array)) {
				// A node decoded from disk (a cache miss, common once the table outgrows the object
				// cache) is frozen — the index store sets freezeData — so assigning node.vector would
				// throw and the catch below would silently drop the node, fragmenting the graph (#1161).
				// Clone the frozen node, memoizing the clone against the frozen node so repeated cache
				// hits skip re-slicing/re-cloning. Mutate in place only the writable just-written object.
				const cached = this.convertedNodes.get(node);
				if (cached) return cached;
				const u8 = node.vector as Uint8Array;
				const vector = new Int8Array(u8.buffer, u8.byteOffset, u8.byteLength).slice();
				if (Object.isFrozen(node)) {
					const converted = { ...node, vector };
					this.convertedNodes.set(node, converted);
					node = converted;
				} else node.vector = vector;
			}
			return node;
		} catch {
			logger.warn?.('Failed to decode HNSW node, skipping', key);
			return undefined;
		}
	}

	private getEntryPoint(options: { transaction?: any } = {}) {
		// Get entry point
		const entryPointId = this.indexStore.getSync(ENTRY_POINT, options);
		if (entryPointId === undefined) return;
		const node = this.safeGetSync(entryPointId, options);
		if (!node) return;
		return { id: entryPointId, ...node };
	}

	/**
	 * Search one layer of the skip-list using HNSW algorithm for creating a candidate list and navigating the graph
	 * TODO: This should be async, but we can't really do that with lmdb-js's transaction system right now. Should be
	 * doable with RocksDB. We could also create an async version for searching.
	 * @param queryVector
	 * @param entryPointId
	 * @param entryPoint
	 * @param ef
	 * @param level
	 * @param distanceFunction
	 * @param options
	 * @private
	 */
	private searchLayer(
		queryVector: number[],
		entryPointId: number,
		entryPoint: any,
		ef: number,
		level: number,
		options: { transaction?: any } = {},
		distanceFunction = this.distance,
		// Predicate-aware traversal (#1241, layer 0 only). `filter` decides result admission by primary
		// key; non-matching nodes still route (they stay in the candidate/visited sets) so the graph
		// remains navigable under selective filters (ACORN). `filterState` carries the visit budget and
		// per-query counters. Both are undefined for routing layers and for unfiltered searches.
		filter?: (primaryKey: Id) => boolean,
		filterState?: FilterState
	): SearchResults {
		// Pre-compute query magnitude for cosine; use cached invMag on stored nodes to skip sqrt per neighbor.
		// Asymmetric distance: the query stays full-precision float; a stored neighbor may be int8
		// (with per-vector `scaleB`) or float (`scaleB` undefined).
		let computeDistance: (b: number[] | Int8Array, invMagB?: number, scaleB?: number) => number;
		if (distanceFunction === cosineDistance) {
			let magASq = 0;
			for (const v of queryVector) magASq += v * v;
			const invMagA = 1 / (Math.sqrt(magASq) || 1);
			computeDistance = (b: number[] | Int8Array, invMagB?: number, scaleB?: number) => {
				let dot = 0;
				for (let i = 0; i < b.length; i++) dot += queryVector[i] * (b[i] as number);
				if (scaleB !== undefined) dot *= scaleB; // dequantize the int8 dot product
				if (invMagB !== undefined) return 1 - dot * invMagA * invMagB;
				// Fallback when the stored node has no cached invMag (a non-cosine index queried as
				// cosine). Compute the stored magnitude and dequantize it by scaleB so it matches the
				// already-dequantized dot product.
				let magBSq = 0;
				for (let i = 0; i < b.length; i++) magBSq += (b[i] as number) * (b[i] as number);
				let magB = Math.sqrt(magBSq) || 1;
				if (scaleB !== undefined) magB *= scaleB;
				return 1 - (dot * invMagA) / magB;
			};
		} else if (distanceFunction === euclideanDistance) {
			// Asymmetric squared-euclidean, dequantizing each int8 component inline (no allocation).
			computeDistance = (b: number[] | Int8Array, _invMagB?: number, scaleB?: number) => {
				if (scaleB === undefined) return distanceFunction(queryVector, b as number[]);
				let distanceSquared = 0;
				for (let i = 0; i < b.length; i++) {
					const diff = queryVector[i] - (b[i] as number) * scaleB;
					distanceSquared += diff * diff;
				}
				return distanceSquared;
			};
		} else {
			// Negated inner product, dequantizing the int8 dot product inline (no allocation).
			computeDistance = (b: number[] | Int8Array, _invMagB?: number, scaleB?: number) => {
				if (scaleB === undefined) return distanceFunction(queryVector, b as number[]);
				let dot = 0;
				for (let i = 0; i < b.length; i++) dot += queryVector[i] * (b[i] as number);
				return -(dot * scaleB);
			};
		}

		const visited = new Set([entryPointId]);
		const initialCandidate: Candidate = {
			id: entryPointId,
			distance: computeDistance(entryPoint.vector, entryPoint.invMag, entryPoint.scale),
			node: entryPoint,
		};

		const candidates = new MinHeap();
		candidates.push(initialCandidate);

		if (!filter) {
			// Unfiltered path (unchanged): results are seeded with the entry point and every visited
			// node is admitted; the stop rule is "closest remaining candidate worse than worst result".
			const results = [initialCandidate] as SearchResults;
			while (candidates.size > 0) {
				const current = candidates.pop()!;
				const furthestDistance = results[results.length - 1].distance;

				if (current.distance > furthestDistance) break;

				for (const { id: neighborId } of current.node[level] || []) {
					if (visited.has(neighborId) || neighborId === undefined) continue;
					visited.add(neighborId);

					const neighbor = this.safeGetSync(neighborId, options);
					if (!neighbor) continue;
					this.nodesVisitedCount++;
					const distance = computeDistance(neighbor.vector, neighbor.invMag, neighbor.scale);

					if (distance < furthestDistance || results.length < ef) {
						const candidate: Candidate = { id: neighborId, distance, node: neighbor };
						candidates.push(candidate);
						results.splice(bisectInsert(results, distance), 0, candidate);
						if (results.length > ef) results.pop();
					}
				}
			}
			results.visited = visited.size;
			return results;
		}

		// Predicate-aware path (#1241). `results` holds only nodes the filter admits, but every visited
		// node still routes: it enters the candidate heap and can be expanded, preserving connectivity
		// through non-matching regions. Because matches accrue slower than visits, the distance stop rule
		// only applies once `ef` matches are in hand; until then we keep expanding.
		//
		// maxVisits = ef * filterExpansion is a hard ceiling on layer-0 node visits. It has to be
		// generous enough NOT to truncate a non-selective filter before it fills `ef` (filling at
		// selectivity `s` costs ~ef/s visits) — that is why the default filterExpansion is larger than a
		// standard-HNSW rule of thumb, since this index visits a large fraction of the graph per query.
		// It matters as a genuine bound in two cases: a selective filter that can never fill `ef` (where
		// the alternative is crawling the whole graph — the same regime the planner diverts to the exact
		// brute-force path for condition filters, leaving function predicates the real beneficiary), and
		// a filter that fills `ef` with distant matches (a loose worst-match bound would otherwise let
		// the distance rule explore almost everything).
		// search() always supplies filterState alongside filter; default one for any direct caller that doesn't.
		if (!filterState) filterState = { maxVisits: Infinity, nodesVisited: 0, filterEvaluations: 0 };
		const results = [] as unknown as SearchResults;
		if (this.admit(filter, filterState, entryPoint.primaryKey)) results.push(initialCandidate);
		let budgetExhausted = false;
		while (candidates.size > 0) {
			const current = candidates.pop()!;
			// Once we have ef matches, the worst of them bounds useful exploration; before that, keep going.
			const furthestDistance = results.length >= ef ? results[results.length - 1].distance : Infinity;
			if (results.length >= ef && current.distance > furthestDistance) break;

			for (const { id: neighborId } of current.node[level] || []) {
				if (visited.has(neighborId) || neighborId === undefined) continue;
				visited.add(neighborId);

				const neighbor = this.safeGetSync(neighborId, options);
				if (!neighbor) continue;
				this.nodesVisitedCount++;
				filterState.nodesVisited++;
				const distance = computeDistance(neighbor.vector, neighbor.invMag, neighbor.scale);

				// Route through any node that could still improve the result set (under-filled or nearer
				// than the current worst match) — filtering does not prune the graph, only admission.
				if (distance < furthestDistance || results.length < ef) {
					const candidate: Candidate = { id: neighborId, distance, node: neighbor };
					candidates.push(candidate);
					if (this.admit(filter, filterState, neighbor.primaryKey)) {
						results.splice(bisectInsert(results, distance), 0, candidate);
						if (results.length > ef) results.pop();
					}
				}
				if (filterState.nodesVisited >= filterState.maxVisits) {
					budgetExhausted = true;
					break;
				}
			}
			if (budgetExhausted) break;
		}
		results.visited = visited.size;
		return results;
	}

	/**
	 * Evaluate the traversal predicate for one node, counting the evaluation for `explain`. Kept as a
	 * tiny helper so both the entry-point seed and the neighbor loop share the counting path. The filter
	 * itself memoizes verdicts per query (a node can be reached from multiple neighbors), so this stays
	 * cheap even when the predicate loads a record.
	 */
	private admit(filter: (primaryKey: Id) => boolean, filterState: FilterState | undefined, primaryKey: Id): boolean {
		if (filterState) filterState.filterEvaluations++;
		return filter(primaryKey);
	}

	/**
	 * This the main entry from Harper's query functionality, where we actually search for an ordered list of nearest
	 * neighbors, using the provided sort/order definition object and performing the multi-layer skip-list search.
	 * This returns an iterable of the nearest neighbors to the provided target vector, with nearest ordered first.
	 * @param target
	 * @param value
	 * @param descending
	 * @param distance
	 * @param comparator
	 * @param context
	 */
	search(
		{
			target,
			value,
			descending,
			distance,
			comparator,
			ef,
			filterExpansion,
		}: {
			target: number[];
			value: number;
			descending: boolean;
			distance: string;
			comparator: string;
			ef?: number;
			filterExpansion?: number;
		},
		context: any,
		// Predicate-aware traversal (#1241). When provided, only nodes for which `filter(primaryKey)`
		// returns true are admitted to the result list at layer 0; routing is unaffected. Composed by
		// search.ts from companion AND conditions and caller-supplied vector/row filters. Must be
		// synchronous and side-effect free. JS-API only (never from a REST query string).
		filter?: (primaryKey: Id) => boolean,
		// offset + limit for a bounded query. A layer-0 search returns at most `ef` candidates, so a
		// query asking for more rows than that used to come back short with no error — capped at 512
		// (AUTO_EF_MAX) however large the limit was. Raising ef to cover the request keeps `limit`
		// meaningful; the caller pays for what it asked for.
		minResults?: number
	) {
		let limit: number | undefined; // only set for threshold comparators; 0 is a valid threshold (e.g. dotProduct)
		let limitInclusive = false; // true for `le`, false for `lt`
		switch (comparator) {
			case 'le':
				limitInclusive = true;
			// fallthrough
			case 'lt':
				limit = value;
			// fallthrough
			case 'sort':
				break;
			default:
				throw new ClientError(`Can not use "${comparator}" comparator with HNSW`);
		}
		// For quantized (int8) threshold queries, suppress the distance limit so the full candidate
		// set is returned; rescoreResults() re-filters on exact full-precision distances post-load.
		if (this.int8 && limit !== undefined) limit = undefined;
		if (descending) throw new ClientError(`Can not use descending sort order with HNSW`);
		let distanceFunction: (a: number[], b: number[]) => number;
		if (distance === 'cosine') distanceFunction = cosineDistance;
		else if (distance === 'euclidean') distanceFunction = euclideanDistance;
		else if (distance === 'dotProduct') distanceFunction = dotProductDistance;
		else if (distance) throw new ClientError('Unknown distance function');
		else distanceFunction = this.distance;
		if (!target) throw new ClientError('A target vector must be provided for an HNSW query');
		if (!Array.isArray(target)) throw new ClientError('The target vector must be an array');

		const options = context.transaction; // should have a nested RocksDB transaction
		// Resolve search ef: per-query ef wins; else use the schema-pinned value (from either ef option);
		// otherwise auto-scale with the graph size so recall holds as the table grows.
		let effectiveEf = this.efConstructionSearch;
		const explicitEf = ef !== undefined && ef > 0;
		if (explicitEf) effectiveEf = ef;
		else if (!this.efSearchConfigured) effectiveEf = autoScaleEf(this.approximateNodeCount());
		// The ef the index chose for itself, before any limit-derived widening. The filter budget below
		// stays calibrated against this rather than against what a caller's `limit` asked for.
		const resolvedEf = effectiveEf;
		// A bounded query must be able to come back full: layer 0 keeps at most `ef` candidates, so a
		// limit above the resolved ef truncated the result set with no error. Widen the candidate list
		// to cover the request, up to LIMIT_EF_MAX — `ef` sizes a synchronous traversal that holds every
		// admitted candidate in a sorted array with an O(len) insert, so an unbounded one lets a plain
		// `limit` stall the thread. Past the ceiling the result set is still short, as it was before.
		// Schema and per-query `ef` pins are authoritative cost ceilings. Only an automatically scaled
		// index widens toward LIMIT_EF_MAX to cover a larger bounded request.
		// The ceiling is the only bound: clamping to the graph size as well would need a count exact as
		// of this query — the memo reads low while a table grows, truncating the very limit this
		// honours — and an ef above the node count is free, the traversal ending at the graph, not ef.
		if (minResults !== undefined && !explicitEf && !this.efSearchConfigured && minResults > effectiveEf) {
			effectiveEf = Math.max(effectiveEf, Math.min(minResults, LIMIT_EF_MAX));
		}
		// Predicate-aware traversal budget (#1241): matches accrue slower than visits under a selective
		// filter, so bound layer-0 work at ef * filterExpansion nodes. Only built when a filter is active.
		// Deliberately `resolvedEf`, not the limit-widened ef: this budget is what stops a selective
		// filter crawling the whole graph, and multiplying it by a caller's limit would turn a filtered
		// vector query into a record-loading scan. When the ef came from the auto-scale (neither a
		// per-query ef nor a schema-configured one), its budget contribution is additionally capped at
		// AUTO_EF_MAX: every budgeted visit is a synchronous record load + predicate evaluation, so the
		// second-regime search ef (up to AUTO_EF_CEILING) must not silently quadruple the filtered
		// worst case — the recall decision and the filtered-scan budget are separate decisions. Callers
		// wanting a deeper filtered search set an explicit ef or filterExpansion, and own the cost.
		const filterState: FilterState | undefined = filter
			? {
					maxVisits:
						(explicitEf || this.efSearchConfigured ? resolvedEf : Math.min(resolvedEf, AUTO_EF_MAX)) *
						(filterExpansion && filterExpansion > 0 ? filterExpansion : this.filterExpansion),
					nodesVisited: 0,
					filterEvaluations: 0,
				}
			: undefined;
		if (this.planeEligible) {
			const plane = this.getPlane(target.length);
			// a query whose dimensionality differs from the graph's takes the JS path (which
			// tolerates the mismatch) rather than erroring or disabling the healthy plane
			if (plane && plane.dims === target.length && this.planeSearchReady(plane)) {
				// Native cutover: same resolved ef, same predicate semantics; resolves to the same
				// entries shape ({ key, distance }) the JS path returns, so rescoreResults and all
				// post-load behavior are unchanged. searchByIndex handles the promise.
				try {
					return this.searchPlane(plane, target, effectiveEf, filter, filterState, options).catch((error) => {
						// an app filter's own throw is the query's failure, not the plane's
						if (error?.[PLANE_PREDICATE_ERROR]) throw error;
						// a failed native search disables the plane and re-runs this query on the JS path
						this.disablePlane(error);
						return this.search(
							{ target, value, descending, distance, comparator, ef, filterExpansion },
							context,
							filter,
							minResults
						);
					});
				} catch (error) {
					// a synchronous NAPI throw (before any promise exists) degrades to the JS path below
					this.disablePlane(error);
				}
			}
		}
		let entryPoint = this.getEntryPoint(options);
		if (!entryPoint) return withStats([], filterState);
		let entryPointId = entryPoint.id;
		let results: Candidate[] = [];
		// For each level from top to bottom. The filter applies only at layer 0 (result admission);
		// upper layers route unfiltered so non-matching hubs still guide the descent.
		//
		// Only layer 0 gets the full candidate list; the layers above it just hand down an entry point,
		// so searching them at the full ef costs work proportional to the layer's population (~N/M
		// nodes) rather than to ef. See DESIGN.md.
		for (let l = entryPoint.level; l >= 0; l--) {
			// Search for closest neighbors at current level
			results = this.searchLayer(
				target,
				entryPointId,
				entryPoint,
				l === 0 ? effectiveEf : ROUTING_EF,
				l,
				options,
				distanceFunction,
				l === 0 ? filter : undefined,
				l === 0 ? filterState : undefined
			);

			if (results.length > 0) {
				const neighbor = results[0]; // closest neighbor becomes new entry point
				entryPoint = neighbor.node;
				entryPointId = neighbor.id;
			}
		}
		if (limit !== undefined)
			results = results.filter((candidate) =>
				limitInclusive ? candidate.distance <= limit : candidate.distance < limit
			);
		return withStats(
			results.map((candidate) => ({
				// we return the result as an entry so we can provide distance as metadata
				key: candidate.node.primaryKey, // return value
				distance: candidate.distance,
			})),
			filterState
		);
	}
	/**
	 * Exact distance between a query and a record's FULL-precision vector, mirroring search()'s metric
	 * selection. Used to rerank quantized (int8) results: graph traversal navigates on approximate
	 * (quantized) distances, but the caller has the exact record vector and can restore exact ordering
	 * and $distance.
	 */
	exactDistance(searchCondition: { target: number[]; distance?: string }, recordVector: number[] | Int8Array): number {
		if (!searchCondition.target) throw new ClientError('A target vector must be provided for an HNSW query');
		if (!Array.isArray(searchCondition.target)) throw new ClientError('The target vector must be an array');
		const fn =
			searchCondition.distance === 'euclidean'
				? euclideanDistance
				: searchCondition.distance === 'dotProduct'
					? dotProductDistance
					: searchCondition.distance === 'cosine'
						? cosineDistance
						: searchCondition.distance
							? null
							: this.distance;
		if (!fn) throw new ClientError('Unknown distance function');
		if (recordVector == null) return Infinity; // missing vector sorts last
		// distance fns require a plain Array (they guard on Array.isArray); records normally store a
		// float[] vector, but convert defensively in case a typed array slips through.
		const vec = Array.isArray(recordVector) ? recordVector : Array.from(recordVector);
		return fn(searchCondition.target, vec);
	}
	/**
	 * Post-load rescoring hook called by search.ts after full records have been loaded.
	 * Handles two quantized (int8) cases:
	 *   - 'sort': recompute exact distances and re-sort for correct nearest-neighbor ordering.
	 *   - 'lt'/'le': recompute exact distances and re-filter by the threshold value (over-fetch
	 *     was applied before the search to ensure enough candidates).
	 * Returns null when rescoring doesn't apply so the caller uses the loaded iterable as-is.
	 */
	rescoreResults(
		loaded: any[],
		searchCondition: { target: number[]; distance?: string; value?: any },
		comparator: string,
		attributeName: string
	): any[] | null {
		if (!this.int8 || !searchCondition.target || typeof attributeName !== 'string') return null;
		if (comparator === 'sort') {
			const rescored = loaded.filter((e) => e !== SKIP && e && e.value);
			for (const e of rescored) {
				const d = this.exactDistance(searchCondition, e.value[attributeName]);
				// Non-finite exact distances (NaN from a corrupt record vector, Infinity from a
				// missing vector) sort last — consistent with the missing-vector sentinel in exactDistance.
				e.distance = Number.isFinite(d) ? d : Infinity;
			}
			// comparison-based (not subtraction) so Infinity sentinels for missing vectors
			// sort last without producing NaN (Infinity - Infinity).
			rescored.sort((a, b) => (a.distance === b.distance ? 0 : a.distance < b.distance ? -1 : 1));
			return rescored;
		}
		if (comparator === 'lt' || comparator === 'le') {
			const thresholdValue = searchCondition.value;
			const rescored = loaded.filter((e) => e !== SKIP && e && e.value);
			for (const e of rescored) e.distance = this.exactDistance(searchCondition, e.value[attributeName]);
			return rescored.filter((e) => (comparator === 'le' ? e.distance <= thresholdValue : e.distance < thresholdValue));
		}
		return null;
	}
	private checkSymmetry(id, node, options) {
		if (!node) return;
		let l = 0;
		let connections: Candidate[];
		while ((connections = node[l])) {
			// verify that the level is not empty, otherwise this means we have an orphaned node
			if (connections.length === 0) break;
			for (const { id: neighbor } of connections) {
				const neighborNode = this.safeGetSync(neighbor, options);
				if (!neighborNode) {
					logger.info?.('could not find neighbor node', neighbor);
					continue;
				}
				// verify that the connection is symmetrical
				const symmetrical = neighborNode[l]?.find(({ id: nid }) => nid == id);
				if (!symmetrical) {
					logger.info?.('asymmetry detected', neighborNode[l], 'does not have', id);
				}
			}
			l++;
		}
	}
	private addConnection(
		fromId: number,
		node: any,
		toId: number,
		level: number,
		distance: number,
		updateNode: (id: number, node?: Node) => any,
		options: any
	) {
		if (!node[level]) {
			node[level] = [];
		}

		let maxConnections = level === 0 ? this.M << 1 : this.M;
		if (this.optimizeRouting) maxConnections <<= 2; // bump up the max connections beyond traditional HNSW because we are naturally limiting
		// have we exceeded the max connections (with 25% grace period)
		if (node[level].length >= maxConnections + (maxConnections >> 2)) {
			logger.debug?.('maxConnections reached, removing some connections', maxConnections);
			// Get all connections with their similarities

			// Sort by distance but prioritize nodes that have reverse connections
			const connections = [...node[level]];
			connections.sort((a, b) => {
				return a.distance - b.distance;
			});

			// Keep the best connections
			const keptConnections = connections.slice(0, maxConnections);
			const removedConnections = connections.slice(maxConnections);

			// Update this node's connections
			node[level] = keptConnections;
			// For removed connections, ensure there's still a path to them
			for (const removed of removedConnections) {
				let removedNode = updateNode(removed.id) ?? this.safeGetSync(removed.id, options);
				if (removedNode) {
					// Remove the reverse connection if it exists
					if (removedNode[level]) {
						const filtered = removedNode[level].filter(({ id }) => id !== fromId);
						if (level === 0 && filtered.length === 0) {
							// don't remove the last connection at level 0 — it would orphan this node
							logger.info?.('skipping removal of last connection', fromId, toId);
						} else {
							removedNode = updateNode(removed.id, removedNode);
							removedNode[level] = filtered;
						}
					}
				}
			}
		}
		if (node[level].find(({ id }) => id === toId)) {
			logger.debug?.('already connected', fromId, toId);
		} else {
			node[level] = [...node[level], { id: toId, distance }]; // add
		}

		//this.indexStore.put(fromId, node, options);
		//this.checkSymmetry(fromId, node, options);
	}
	validateConnectivity(startLevel: number = 0) {
		const entryPoint = this.getEntryPoint();
		if (!entryPoint) return;
		const visited = new Set<number>();

		// BFS from entry point to ensure all nodes are reachable. Asymmetric stale neighbor
		// references can survive deletes, so a referenced node may not actually exist anymore;
		// only count a node as visited once we confirm the underlying record is present.
		const queue: number[] = [entryPoint.id];
		const enqueued = new Set<number>([entryPoint.id]);
		let connections = 0;

		while (queue.length > 0) {
			const currentId = queue.shift()!;
			const current = this.safeGetSync(currentId);
			if (!current) continue;
			visited.add(currentId);

			for (let level = startLevel; level <= current.level; level++) {
				for (const { id: neighborId } of current[level] || []) {
					connections++;
					if (!enqueued.has(neighborId)) {
						enqueued.add(neighborId);
						queue.push(neighborId);
					}
				}
			}
		}

		// Check if all nodes are reachable
		// This would require maintaining a separate set/count of all nodes
		return {
			isFullyConnected: visited.size === this.totalNodes,
			averageConnections: connections / visited.size,
		};
	}
	get totalNodes() {
		return Array.from(this.indexStore.getKeys({ start: 0, end: Infinity })).length;
	}

	/**
	 * This is used by the query planner to determine what order to apply conditions. It is our best guess at an estimated count.
	 * This unit is typically the number of records that need to be accessed to satisfy the query. We know that we will visit
	 * a minimum of efConstructionSearch nodes and a maximum of the total nodes (in absolute worst case).
	 * The original paper described the complexity as polylogarithmic. From my testing, the
	 * best and simplest guess at the number of nodes that need to be accessed is the geometric mean of the total number of nodes
	 * and the efConstruction parameter (for search), which clearly constrains the estimate to the correct range and is
	 * similar to polylogarithmic for realistic values.
	 *
	 * @returns
	 */
	estimateCountAsSort() {
		// Same O(1) source search() uses — this runs per query whenever a vector sort is planned
		// alongside another condition, where an exact getKeysCount() is a second full key scan on the
		// query path. Scaled back to the index-store key count it used to be given, so the planner's
		// condition ordering is unchanged by the switch to a node count.
		return Math.sqrt(this.approximateNodeCount() * INDEX_KEYS_PER_NODE * this.efConstructionSearch);
	}

	/**
	 * This is used to resolve the vector property, which should be resolved to the distance when used in a sort comparator
	 * We also want to cache distance calculations so they can be accessed efficently later
	 * @param vector
	 * @param context
	 * @param entry
	 * @param sortDefinition
	 */
	propertyResolver(vector: number[], context: any, entry: any, sortDefinition?: any) {
		if (sortDefinition) {
			if (!context) return this.exactDistance(sortDefinition, vector);
			// set up a cache for these so they can be accessed by $distance and not be recalculated during a sort
			let vectorDistanceCaches = context.vectorDistanceCaches;
			if (!vectorDistanceCaches) vectorDistanceCaches = context.vectorDistanceCaches = new WeakMap();
			let vectorDistances = vectorDistanceCaches.get(sortDefinition);
			const cacheKey =
				entry && typeof entry === 'object' ? entry : vector && typeof vector === 'object' ? vector : null;
			if (vectorDistances && cacheKey) {
				const difference = vectorDistances.get(cacheKey);
				if (difference !== undefined) return difference;
			} else if (!vectorDistances) vectorDistanceCaches.set(sortDefinition, (vectorDistances = new WeakMap()));

			const distance = this.exactDistance(sortDefinition, vector);
			if (cacheKey) vectorDistances.set(cacheKey, distance);
			return distance;
		}
		return vector;
	}
}
type WithCopied = Connection[] & { copied: boolean };
type Candidate = {
	id: number;
	distance: number;
	node: Node;
};
type SearchResults = Candidate[] & { visited: number };
// Per-query state for predicate-aware traversal (#1241): the visit budget plus counters surfaced for
// tuning (nodesVisited / filterEvaluations). One instance per search(), threaded to the layer-0 searchLayer.
type FilterState = {
	maxVisits: number;
	nodesVisited: number;
	filterEvaluations: number;
};
/**
 * Attach filtered-traversal counters to the returned entries array so callers (search.ts / explain) can
 * report how much of the graph a filtered query touched. No-op for unfiltered searches. Non-enumerable so
 * the stats don't leak into iteration/serialization of the result entries.
 */
function withStats<T extends any[]>(entries: T, filterState: FilterState | undefined): T {
	if (filterState) {
		Object.defineProperty(entries, 'nodesVisited', { value: filterState.nodesVisited, enumerable: false });
		Object.defineProperty(entries, 'filterEvaluations', { value: filterState.filterEvaluations, enumerable: false });
	}
	return entries;
}
