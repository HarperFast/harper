/**
 * YCSB-style workload generator for Harper CRUD load testing.
 *
 * Transport-agnostic: this module defines the record/key model, the YCSB key
 * distributions (uniform / zipfian / latest), the standard workload op-mixes
 * (A–F), a dependency-free latency recorder, and a closed-loop concurrent
 * runner. The actual request transport is supplied as an `OpExecutor` (see
 * restClient.mts), so the same workloads drive a single node or a cluster.
 *
 * Beyond A–F, three application workloads read a record's contents before they can answer
 * (benchmarks/ycsb/app/dependentReads.mjs): `inspect` (row-level owner check and a projection) and
 * `chain-N` (N dependent reads following each record's link). Every record carries that link and its
 * owner at the start of `field0` (see `buildRecord`).
 *
 * The distribution generators are ports of the reference YCSB Java generators
 * (Apache-2.0): ZipfianGenerator + ScrambledZipfianGenerator for hotspot
 * skew, and a Latest generator for read-recently-inserted workloads.
 */

export type DistributionName = 'uniform' | 'zipfian' | 'latest';

export type OperationType = 'read' | 'update' | 'insert' | 'scan' | 'rmw' | 'inspect' | 'chain';

/** Proportion of each operation type within a workload (values sum to 1). */
export type OpMix = Partial<Record<OperationType, number>>;

export interface WorkloadSpec {
	name: string;
	description: string;
	mix: OpMix;
	/** Default request distribution; overridable from the CLI. */
	distribution: DistributionName;
	/** `chain` ops: links followed per request (hops + 1 record reads). */
	chainHops?: number;
}

/** Records have row-level owners `owner00`..`owner19`, by key index. */
export const OWNER_COUNT = 20;
/** One `inspect` in DENY_EVERY comes from a caller who does not own the record. */
export const DENY_EVERY = 20;

/** The canonical YCSB core workloads, then the dependent-read ones. */
export const WORKLOADS: Record<string, WorkloadSpec> = {
	A: {
		name: 'A',
		description: 'Update heavy (50% read / 50% update)',
		mix: { read: 0.5, update: 0.5 },
		distribution: 'zipfian',
	},
	B: {
		name: 'B',
		description: 'Read mostly (95% read / 5% update)',
		mix: { read: 0.95, update: 0.05 },
		distribution: 'zipfian',
	},
	C: {
		name: 'C',
		description: 'Read only (100% read)',
		mix: { read: 1.0 },
		distribution: 'zipfian',
	},
	D: {
		name: 'D',
		description: 'Read latest (95% read / 5% insert), read recently inserted',
		mix: { read: 0.95, insert: 0.05 },
		distribution: 'latest',
	},
	E: {
		name: 'E',
		description: 'Short ranges (95% scan / 5% insert)',
		mix: { scan: 0.95, insert: 0.05 },
		distribution: 'zipfian',
	},
	F: {
		name: 'F',
		description: 'Read-modify-write (50% read / 50% read-modify-write)',
		mix: { read: 0.5, rmw: 0.5 },
		distribution: 'zipfian',
	},
	inspect: {
		name: 'inspect',
		description: `Fetch and inspect (owner check, ${100 / DENY_EVERY}% denied with 403, projection)`,
		mix: { inspect: 1.0 },
		distribution: 'zipfian',
	},
	...Object.fromEntries(
		[1, 2, 4].map((hops) => [
			`chain-${hops}`,
			{
				name: `chain-${hops}`,
				description: `Dependent reads (${hops + 1} records, each key read from the one before)`,
				mix: { chain: 1.0 },
				distribution: 'zipfian' as const,
				chainHops: hops,
			},
		])
	),
};

/** Record reads one op of the workload makes on average, for sizing runs by reads rather than ops. */
export function recordReadsPerOp(spec: WorkloadSpec): number {
	return 1 + (spec.chainHops ?? 0);
}

/** Whether the workload's requests follow record links (and so need `field0` long enough to hold one). */
export function usesDependentReads(spec: WorkloadSpec): boolean {
	return Boolean(spec.mix.inspect || spec.mix.chain);
}

// ---------------------------------------------------------------------------
// Key distributions (ports of the reference YCSB generators)
// ---------------------------------------------------------------------------

const ZIPFIAN_CONSTANT = 0.99;

/** Skewed generator over [min, max]. Recomputes zeta incrementally on growth. */
export class ZipfianGenerator {
	private readonly items: number;
	private readonly base: number;
	private readonly theta: number;
	private readonly zeta2theta: number;
	private readonly alpha: number;
	private countForZeta: number;
	private zetan: number;
	private eta: number;

	constructor(min: number, max: number, zipfianConstant = ZIPFIAN_CONSTANT, precomputedZetan?: number) {
		this.items = max - min + 1;
		this.base = min;
		this.theta = zipfianConstant;
		this.zeta2theta = zetaFromScratch(2, this.theta);
		this.alpha = 1 / (1 - this.theta);
		this.countForZeta = this.items;
		this.zetan = precomputedZetan ?? zetaFromScratch(this.items, this.theta);
		this.eta = (1 - Math.pow(2 / this.items, 1 - this.theta)) / (1 - this.zeta2theta / this.zetan);
	}

	nextLong(itemCount: number): number {
		if (itemCount !== this.countForZeta && itemCount > this.countForZeta) {
			// keyspace grew (inserts) — extend zeta incrementally rather than recompute.
			// In this codebase the generator is always called with a fixed universe (KeyState
			// resizes one layer up), so this branch is effectively unused — but keep it
			// reference-faithful (eta uses the grown itemCount, not the constructor items).
			this.zetan = zetaIncremental(this.countForZeta, itemCount, this.theta, this.zetan);
			this.countForZeta = itemCount;
			this.eta = (1 - Math.pow(2 / itemCount, 1 - this.theta)) / (1 - this.zeta2theta / this.zetan);
		}
		return this.fromUniform(Math.random(), itemCount);
	}

	/** The draw for uniform `u` in [0, 1); `nextLong` with the randomness supplied. */
	fromUniform(u: number, itemCount: number): number {
		const uz = u * this.zetan;
		if (uz < 1) return this.base;
		if (uz < 1 + Math.pow(0.5, this.theta)) return this.base + 1;
		return this.base + Math.floor(itemCount * Math.pow(this.eta * u - this.eta + 1, this.alpha));
	}
}

function zetaFromScratch(n: number, theta: number): number {
	return zetaIncremental(0, n, theta, 0);
}

function zetaIncremental(start: number, n: number, theta: number, startSum: number): number {
	let sum = startSum;
	for (let i = start; i < n; i++) {
		sum += 1 / Math.pow(i + 1, theta);
	}
	return sum;
}

// Precomputed for ITEM_COUNT below so we never iterate 10^10 times. These are
// the reference YCSB constants for zipfianConstant = 0.99.
const SCRAMBLE_ITEM_COUNT = 10_000_000_000;
const SCRAMBLE_ZETAN = 26.46902820178302;

/** Zipfian with the hot items scattered uniformly across the keyspace (FNV hash). */
export class ScrambledZipfianGenerator {
	private readonly gen: ZipfianGenerator;

	constructor() {
		this.gen = new ZipfianGenerator(0, SCRAMBLE_ITEM_COUNT - 1, ZIPFIAN_CONSTANT, SCRAMBLE_ZETAN);
	}

	/** Returns an index in [0, itemCount). */
	next(itemCount: number): number {
		return this.fromUniform(Math.random(), itemCount);
	}

	fromUniform(u: number, itemCount: number): number {
		return Number(fnv64(this.gen.fromUniform(u, SCRAMBLE_ITEM_COUNT)) % BigInt(itemCount));
	}
}

const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = (1n << 64n) - 1n;

function fnv64(value: number): bigint {
	let hash = FNV_OFFSET_BASIS_64;
	let v = BigInt(value);
	for (let i = 0; i < 8; i++) {
		const octet = v & 0xffn;
		v >>= 8n;
		hash ^= octet;
		hash = (hash * FNV_PRIME_64) & MASK_64;
	}
	return hash;
}

export interface KeyChooser {
	/** Returns an index in [0, keyCount). */
	next(keyCount: number): number;
}

class UniformChooser implements KeyChooser {
	next(keyCount: number): number {
		return Math.floor(Math.random() * keyCount);
	}
}

class ZipfianChooser implements KeyChooser {
	private readonly gen = new ScrambledZipfianGenerator();
	next(keyCount: number): number {
		return this.gen.next(keyCount);
	}
}

/** Biased toward the most recently inserted keys (high indices). */
class LatestChooser implements KeyChooser {
	private readonly zipf = new ZipfianGenerator(0, SCRAMBLE_ITEM_COUNT - 1, ZIPFIAN_CONSTANT, SCRAMBLE_ZETAN);
	next(keyCount: number): number {
		const rank = this.zipf.nextLong(SCRAMBLE_ITEM_COUNT) % keyCount;
		return keyCount - 1 - rank;
	}
}

export function makeKeyChooser(distribution: DistributionName): KeyChooser {
	switch (distribution) {
		case 'uniform':
			return new UniformChooser();
		case 'zipfian':
			return new ZipfianChooser();
		case 'latest':
			return new LatestChooser();
	}
}

// ---------------------------------------------------------------------------
// Record / key model
// ---------------------------------------------------------------------------

const CHARSET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// A large pool of random characters; field values are sliced from it cheaply so
// value generation never becomes the client-side bottleneck.
const VALUE_POOL_SIZE = 1 << 20;
let valuePool: string | undefined;

function getValuePool(): string {
	if (valuePool === undefined) {
		const chars = new Array<string>(VALUE_POOL_SIZE);
		for (let i = 0; i < VALUE_POOL_SIZE; i++) {
			chars[i] = CHARSET[(Math.random() * CHARSET.length) | 0];
		}
		valuePool = chars.join('');
	}
	return valuePool;
}

function randomValue(length: number): string {
	const pool = getValuePool();
	if (length >= pool.length) {
		throw new Error(`field-length ${length} exceeds the ${pool.length}-char value pool; raise VALUE_POOL_SIZE`);
	}
	const start = (Math.random() * (pool.length - length)) | 0;
	return pool.slice(start, start + length);
}

export interface RecordShape {
	fieldCount: number;
	fieldLength: number;
}

export function ownerOf(index: number): string {
	return 'owner' + String(index % OWNER_COUNT).padStart(2, '0');
}

const linkChooser = new ScrambledZipfianGenerator();
const LINK_SEED = 0x5ca1ab1e;

function mix32(value: number): number {
	let x = value | 0;
	x ^= x >>> 16;
	x = Math.imul(x, 0x7feb352d);
	x ^= x >>> 15;
	x = Math.imul(x, 0x846ca68b);
	x ^= x >>> 16;
	return x >>> 0;
}

/**
 * The key index record `index` links to, out of `keyCount` loaded keys: a scrambled-zipfian draw (the
 * request distribution's popularity, so the most requested keys are also the most linked-to) taken
 * from a hash of the index instead of Math.random, so every engine, rep and rewrite of the record
 * holds the same link. Never the record itself.
 */
export function linkTarget(index: number, keyCount: number): number {
	for (let attempt = 0; ; attempt++) {
		const high = mix32(index ^ mix32(LINK_SEED + attempt));
		const low = mix32(high ^ mix32(index + 0x9e3779b9));
		const u = (high * 0x200000 + (low >>> 11)) / 0x20000000000000;
		const target = linkChooser.fromUniform(u, keyCount);
		if (target !== index || keyCount === 1) return target;
	}
}

/** Where a record's link points: `index` and the loaded keyspace its links stay within. */
export interface RecordLink {
	index: number;
	keyCount: number;
	keyWidth: number;
}

/** `<next key>:<owner>:`, the start of `field0`; parsed by app/dependentReads.mjs `parseLink`. */
export function linkPrefix(link: RecordLink): string {
	return `${formatKey(linkTarget(link.index, link.keyCount), link.keyWidth)}:${ownerOf(link.index)}:`;
}

export function linkPrefixLength(keyWidth: number): number {
	return formatKey(0, keyWidth).length + ownerOf(0).length + 2;
}

/** A record with `link` written at the start of `field0`, unless `field0` is too short to hold it. */
export function buildRecord(shape: RecordShape, link?: RecordLink): Record<string, string> {
	const record: Record<string, string> = {};
	for (let i = 0; i < shape.fieldCount; i++) {
		record['field' + i] = randomValue(shape.fieldLength);
	}
	if (link && shape.fieldCount > 0 && linkPrefixLength(link.keyWidth) <= shape.fieldLength) {
		const prefix = linkPrefix(link);
		record.field0 = prefix + record.field0.slice(prefix.length);
	}
	return record;
}

export function formatKey(index: number, width: number): string {
	return 'user' + String(index).padStart(width, '0');
}

// ---------------------------------------------------------------------------
// Operation execution
// ---------------------------------------------------------------------------

/** Transport binding the runner drives. Implemented by restClient.mts. */
export interface OpExecutor {
	read(key: string): Promise<void>;
	insert(key: string, record: Record<string, string>): Promise<void>;
	update(key: string, record: Record<string, string>): Promise<void>;
	/** Read the record, then write it back (full replace). */
	readModifyWrite(key: string, record: Record<string, string>): Promise<void>;
	/** Scan up to `count` records starting at `startKey` (inclusive). */
	scan(startKey: string, count: number): Promise<void>;
	/** GET /inspect/<key> as `caller`; must answer 403 when `forbidden`, 200 otherwise. */
	inspect(key: string, caller: string, forbidden: boolean): Promise<void>;
	/** GET /chain/<key>?hops=<hops>. */
	chain(key: string, hops: number): Promise<void>;
}

/** Live keyspace state shared by the workers driving a single workload run. */
export class KeyState {
	private readonly chooser: KeyChooser;
	private readonly width: number;
	private readonly shape: RecordShape;
	private readonly maxScanLength: number;
	// Inserted keys only become readable once their write is acknowledged, and
	// only across the contiguous prefix — mirroring YCSB's AcknowledgedCounter.
	// Without this, a `latest` reader races the in-flight insert and 404s.
	private readableCount: number;
	private insertCursor: number;
	private readonly pendingAcks = new Set<number>();
	private readonly linkKeyCount: number;
	private inspects = 0;

	constructor(opts: {
		distribution: DistributionName;
		initialKeyCount: number;
		/** The loaded keyspace every written record links into; defaults to `initialKeyCount`. */
		linkKeyCount?: number;
		keyWidth: number;
		shape: RecordShape;
		maxScanLength: number;
	}) {
		this.chooser = makeKeyChooser(opts.distribution);
		this.readableCount = opts.initialKeyCount;
		this.insertCursor = opts.initialKeyCount;
		this.linkKeyCount = opts.linkKeyCount ?? opts.initialKeyCount;
		this.width = opts.keyWidth;
		this.shape = opts.shape;
		this.maxScanLength = opts.maxScanLength;
	}

	existingIndex(): number {
		if (this.readableCount === 0) {
			throw new Error('no readable keys — the load phase inserted/acknowledged 0 records');
		}
		return this.chooser.next(this.readableCount);
	}

	existingKey(): string {
		return this.key(this.existingIndex());
	}

	key(index: number): string {
		return formatKey(index, this.width);
	}

	/**
	 * Current readable key count, including any keys this run inserted. Used to seed a
	 * subsequent repetition's `initialKeyCount` so reps keep growing the keyspace (each
	 * rep's inserts allocate fresh keys) instead of re-inserting the same keys as PUT
	 * overwrites — matching how one continuous run would evolve the dataset.
	 */
	get keyCount(): number {
		return this.readableCount;
	}

	/** Allocate a new key beyond the loaded range. Not readable until acknowledged. */
	nextInsert(): { index: number; key: string } {
		const index = this.insertCursor++;
		return { index, key: formatKey(index, this.width) };
	}

	/** Mark an insert complete; advances the readable frontier over the contiguous prefix. */
	acknowledgeInsert(index: number): void {
		this.pendingAcks.add(index);
		while (this.pendingAcks.delete(this.readableCount)) {
			this.readableCount++;
		}
	}

	/** A fresh value for key `index`, keeping the record's link and owner. */
	record(index: number): Record<string, string> {
		return buildRecord(this.shape, { index, keyCount: this.linkKeyCount, keyWidth: this.width });
	}

	/** Who sends the next inspect of key `index`: its owner, except one in DENY_EVERY from another owner. */
	inspectCaller(index: number): { caller: string; forbidden: boolean } {
		const forbidden = ++this.inspects % DENY_EVERY === 0;
		return { caller: ownerOf(forbidden ? index + 1 : index), forbidden };
	}

	scanLength(): number {
		return 1 + ((Math.random() * this.maxScanLength) | 0);
	}
}

interface WeightedOp {
	type: OperationType;
	cumulative: number;
}

function buildPicker(mix: OpMix): WeightedOp[] {
	const total = Object.values(mix).reduce((a, b) => a + (b ?? 0), 0);
	const picker: WeightedOp[] = [];
	let cumulative = 0;
	for (const [type, weight] of Object.entries(mix)) {
		if (!weight) continue;
		cumulative += weight / total;
		picker.push({ type: type as OperationType, cumulative });
	}
	// guard against float drift so the last bucket always wins
	picker[picker.length - 1].cumulative = 1;
	return picker;
}

function pickOp(picker: WeightedOp[]): OperationType {
	const r = Math.random();
	for (const op of picker) {
		if (r < op.cumulative) return op.type;
	}
	return picker[picker.length - 1].type;
}

async function executeOp(type: OperationType, executor: OpExecutor, keys: KeyState, chainHops: number): Promise<void> {
	switch (type) {
		case 'read':
			return executor.read(keys.existingKey());
		case 'update': {
			const index = keys.existingIndex();
			return executor.update(keys.key(index), keys.record(index));
		}
		case 'rmw': {
			const index = keys.existingIndex();
			return executor.readModifyWrite(keys.key(index), keys.record(index));
		}
		case 'insert': {
			const { index, key } = keys.nextInsert();
			try {
				await executor.insert(key, keys.record(index));
			} finally {
				// Always advance the frontier, even on failure — otherwise one failed insert
				// permanently stalls readableCount and leaks pendingAcks. A failed key may then
				// 404 on a later read (counted as an error), proportionate to the failure rate.
				keys.acknowledgeInsert(index);
			}
			return;
		}
		case 'scan':
			return executor.scan(keys.existingKey(), keys.scanLength());
		case 'inspect': {
			const index = keys.existingIndex();
			const { caller, forbidden } = keys.inspectCaller(index);
			return executor.inspect(keys.key(index), caller, forbidden);
		}
		case 'chain':
			return executor.chain(keys.existingKey(), chainHops);
	}
}

// ---------------------------------------------------------------------------
// Latency recording
// ---------------------------------------------------------------------------

export interface LatencyStats {
	count: number;
	min: number;
	max: number;
	mean: number;
	p50: number;
	p95: number;
	p99: number;
	p999: number;
}

/** Records per-operation-type latencies (ms) and computes percentiles. */
export class LatencyRecorder {
	private readonly samples = new Map<OperationType, number[]>();
	errors = 0;

	record(type: OperationType, ms: number): void {
		let arr = this.samples.get(type);
		if (arr === undefined) {
			arr = [];
			this.samples.set(type, arr);
		}
		arr.push(ms);
	}

	statsByType(): Partial<Record<OperationType, LatencyStats>> {
		const out: Partial<Record<OperationType, LatencyStats>> = {};
		for (const [type, arr] of this.samples) {
			out[type] = summarize(arr);
		}
		return out;
	}

	totalCount(): number {
		let total = 0;
		for (const arr of this.samples.values()) total += arr.length;
		return total;
	}
}

function summarize(samplesInput: number[]): LatencyStats {
	const samples = samplesInput.slice().sort((a, b) => a - b);
	const n = samples.length;
	const percentile = (p: number): number => (n === 0 ? 0 : samples[Math.min(n - 1, Math.floor(p * n))]);
	let sum = 0;
	for (const v of samples) sum += v;
	return {
		count: n,
		min: n === 0 ? 0 : samples[0],
		max: n === 0 ? 0 : samples[n - 1],
		mean: n === 0 ? 0 : sum / n,
		p50: percentile(0.5),
		p95: percentile(0.95),
		p99: percentile(0.99),
		p999: percentile(0.999),
	};
}

// ---------------------------------------------------------------------------
// Closed-loop runner
// ---------------------------------------------------------------------------

export interface PhaseResult {
	ops: number;
	errors: number;
	elapsedMs: number;
	throughput: number;
	latency: Partial<Record<OperationType, LatencyStats>>;
}

export interface RunOptions {
	opCount: number;
	concurrency: number;
	mix: OpMix;
	executor: OpExecutor;
	keys: KeyState;
	/** Required when the mix has `chain` ops. */
	chainHops?: number;
	onProgress?: (done: number, total: number) => void;
	progressEvery?: number;
}

/**
 * Drives `opCount` operations with a fixed number of in-flight requests
 * (`concurrency`). Each virtual client issues its next request as soon as the
 * previous completes, so throughput reflects the server, not a fixed rate.
 */
export async function runOperations(options: RunOptions): Promise<PhaseResult> {
	const { opCount, concurrency, mix, executor, keys } = options;
	if (mix.chain && options.chainHops === undefined) throw new Error('a mix with chain ops needs chainHops');
	const chainHops = options.chainHops ?? 0;
	const picker = buildPicker(mix);
	const recorder = new LatencyRecorder();
	const progressEvery = options.progressEvery ?? Math.max(1, Math.floor(opCount / 10));
	let dispatched = 0;

	const worker = async (): Promise<void> => {
		while (true) {
			const index = dispatched++;
			if (index >= opCount) break;
			const type = pickOp(picker);
			const start = performance.now();
			try {
				await executeOp(type, executor, keys, chainHops);
				recorder.record(type, performance.now() - start);
			} catch {
				recorder.errors++;
			}
			if (options.onProgress && index % progressEvery === 0) {
				options.onProgress(index, opCount);
			}
		}
	};

	const start = performance.now();
	await Promise.all(Array.from({ length: concurrency }, worker));
	const elapsedMs = performance.now() - start;
	const ops = recorder.totalCount();
	return {
		ops,
		errors: recorder.errors,
		elapsedMs,
		throughput: ops === 0 ? 0 : (ops * 1000) / elapsedMs,
		latency: recorder.statsByType(),
	};
}
