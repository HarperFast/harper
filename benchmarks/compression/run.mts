/**
 * RocksDB compression comparison — none / snappy / lz4 / zstd (and any other
 * codec the native build supports).
 *
 * Compression in RocksDB is a per-column-family property fixed while the CF is
 * open, so each codec gets its own Harper instance on a fresh data directory.
 * Every instance runs the identical workload against the identical generated
 * dataset (seeded PRNG), so the only variable is HARPER_STORAGE_ROCKS_COMPRESSION.
 *
 * Per codec the run reports:
 *   - insert / update / point-read / scan throughput through the REST interface
 *   - on-disk bytes after a clean shutdown, split by file class (SST, blob,
 *     WAL, transaction log, other) — only SST and blob bytes are subject to the
 *     CF codec, so mixing the rest into a "compression ratio" understates it.
 *     These are sizes as the workload left them, not a compacted steady state:
 *     nothing outside the process can force a RocksDB compaction, so the update
 *     phase's obsolete versions are still present in every codec's number
 *   - CPU seconds consumed by the Harper process tree
 *
 * Datasets (`--dataset`):
 *   realistic — document-shaped records with low-cardinality enum fields, ISO
 *               timestamps, prose and a nested object. Representative of what
 *               compression actually does for Harper users.
 *   random    — the same shape and roughly the same serialized size filled with
 *               high-entropy content. The incompressible floor: whatever a codec
 *               costs here is pure CPU overhead with no space to win back.
 *
 * The block cache is pinned small (`--block-cache`) on purpose. With Harper's
 * default cache (25% of RAM) a benchmark-sized dataset is served entirely from
 * uncompressed cached blocks and every codec reads identically — the cache has
 * to miss for decompression to appear in the read numbers at all.
 *
 * Build Harper first (npm run build), then:
 *   node benchmarks/compression/run.mts
 *   node benchmarks/compression/run.mts --scale=large --dataset=both
 *   node benchmarks/compression/run.mts --codecs=none,zstd --records=500000
 *
 * Result lines (parseable):
 *   COMPRESSION_RESULT codec=zstd dataset=realistic insert_ops_per_sec=... sst_blob_bytes=...
 */
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { readdir, stat, readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import http from 'node:http';
import {
	createHarperContext,
	setupHarperWithFixture,
	killHarper,
	teardownHarper,
} from '@harperfast/integration-testing';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HARPER_BIN = join(REPO_ROOT, 'dist', 'bin', 'harper.js');
const APP_DIR = join(import.meta.dirname, 'app');

// The integration-testing default install parent is os.tmpdir(), which on most
// Linux boxes is tmpfs — i.e. RAM. Every byte this benchmark reports would then
// be a memory measurement, and no read would ever touch a device. Force the
// instances onto real storage unless the caller has already chosen a location.
// Kept directly under $HOME and short: the instance's operations domain socket
// path is built from this and has to stay inside the 107-byte sockaddr_un limit.
process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR ??= join(homedir(), '.harper-compression-bench');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const SCALE_PRESETS: Record<string, { records: number; reads: number; updates: number; scans: number }> = {
	quick: { records: 50_000, reads: 30_000, updates: 15_000, scans: 3_000 },
	standard: { records: 200_000, reads: 100_000, updates: 50_000, scans: 10_000 },
	large: { records: 1_000_000, reads: 300_000, updates: 150_000, scans: 20_000 },
};

interface CliOptions {
	codecs: string[];
	datasets: string[];
	records: number;
	reads: number;
	updates: number;
	scans: number;
	concurrency: number;
	threads: number;
	blockCacheBytes: number;
	warmup: number;
	settleSeconds: number;
	maxErrorRate: number;
	startupTimeoutMs: number;
	out: string;
}

function parseOptions(): CliOptions {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			'scale': { type: 'string', default: 'standard' },
			'codecs': { type: 'string', default: 'none,snappy,lz4,zstd' },
			'dataset': { type: 'string', default: 'realistic' },
			'records': { type: 'string' },
			'reads': { type: 'string' },
			'updates': { type: 'string' },
			'scans': { type: 'string' },
			'concurrency': { type: 'string', default: '32' },
			'threads': { type: 'string', default: '4' },
			'block-cache': { type: 'string', default: '67108864' },
			'warmup': { type: 'string', default: '2000' },
			'settle': { type: 'string', default: '45' },
			'max-error-rate': { type: 'string', default: '0.005' },
			'startup-timeout': { type: 'string', default: '180000' },
			'out': { type: 'string', default: join(import.meta.dirname, 'results') },
		},
		allowPositionals: false,
	});

	const preset = SCALE_PRESETS[values.scale as string];
	if (!preset) throw new Error(`unknown scale "${values.scale}" (expected: ${Object.keys(SCALE_PRESETS).join(', ')})`);

	const dataset = values.dataset as string;
	const datasets = dataset === 'both' ? ['realistic', 'random'] : [dataset];
	for (const d of datasets) {
		if (d !== 'realistic' && d !== 'random')
			throw new Error(`unknown dataset "${d}" (expected: realistic, random, both)`);
	}

	return {
		codecs: (values.codecs as string)
			.split(',')
			.map((c) => c.trim())
			.filter(Boolean),
		datasets,
		records: values.records ? Number(values.records) : preset.records,
		reads: values.reads ? Number(values.reads) : preset.reads,
		updates: values.updates ? Number(values.updates) : preset.updates,
		scans: values.scans ? Number(values.scans) : preset.scans,
		concurrency: Number(values.concurrency),
		threads: Number(values.threads),
		blockCacheBytes: Number(values['block-cache']),
		warmup: Number(values.warmup),
		settleSeconds: Number(values.settle),
		maxErrorRate: Number(values['max-error-rate']),
		startupTimeoutMs: Number(values['startup-timeout']),
		out: values.out as string,
	};
}

// ---------------------------------------------------------------------------
// Dataset generation
//
// Seeded so every codec and every run sees byte-identical records — a codec
// comparison against differently-generated data measures nothing.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const CATEGORIES = [
	'electronics',
	'home-garden',
	'apparel',
	'sporting-goods',
	'toys-games',
	'grocery',
	'automotive',
	'office-supplies',
	'health-beauty',
	'pet-supplies',
];
const BRANDS = [
	'Northwind',
	'Contoso',
	'Fabrikam',
	'Litware',
	'Proseware',
	'Adventure Works',
	'Tailspin',
	'Wingtip',
	'Woodgrove',
	'Lamna',
	'Relecloud',
	'Trey Research',
];
const REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'eu-west-1', 'ap-southeast-2', 'sa-east-1'];
const STATUSES = ['active', 'active', 'active', 'discontinued', 'backordered', 'pending-review'];
const CURRENCIES = ['USD', 'USD', 'USD', 'EUR', 'GBP', 'JPY'];
const WORDS = (
	'the a of and to in for with on this that product is are was were designed built quality durable ' +
	'lightweight premium standard edition includes features material finish available sizes colors ' +
	'warranty shipping returns customer satisfaction guaranteed compatible suitable indoor outdoor ' +
	'professional everyday use resistant water dust weight capacity performance efficient reliable'
).split(' ');
const TAG_POOL = [
	'new',
	'sale',
	'clearance',
	'featured',
	'bestseller',
	'seasonal',
	'limited',
	'eco-friendly',
	'imported',
	'handmade',
	'bulk',
	'refurbished',
];

/** Base64-ish high-entropy string of `length` characters. */
function randomString(rand: () => number, length: number): string {
	const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	let s = '';
	for (let i = 0; i < length; i++) s += ALPHABET[(rand() * 64) | 0];
	return s;
}

function prose(rand: () => number, wordCount: number): string {
	const parts = new Array<string>(wordCount);
	for (let i = 0; i < wordCount; i++) parts[i] = WORDS[(rand() * WORDS.length) | 0];
	return parts.join(' ');
}

const BASE_EPOCH = Date.UTC(2024, 0, 1);

function realisticRecord(rand: () => number, i: number): Record<string, unknown> {
	const created = BASE_EPOCH + Math.floor(rand() * 730 * 86_400_000);
	const tagCount = 1 + ((rand() * 4) | 0);
	const tags = new Array<string>(tagCount);
	for (let t = 0; t < tagCount; t++) tags[t] = TAG_POOL[(rand() * TAG_POOL.length) | 0];
	return {
		sku: 'SKU-' + String(i % 100_000).padStart(8, '0'),
		category: CATEGORIES[(rand() * CATEGORIES.length) | 0],
		brand: BRANDS[(rand() * BRANDS.length) | 0],
		region: REGIONS[(rand() * REGIONS.length) | 0],
		status: STATUSES[(rand() * STATUSES.length) | 0],
		currency: CURRENCIES[(rand() * CURRENCIES.length) | 0],
		title: prose(rand, 6),
		description: prose(rand, 70),
		price: Math.round(rand() * 250_000) / 100,
		quantity: (rand() * 5000) | 0,
		rating: Math.round(rand() * 50) / 10,
		createdAt: new Date(created).toISOString(),
		updatedAt: new Date(created + Math.floor(rand() * 86_400_000 * 30)).toISOString(),
		tags,
		attributes: {
			color: ['black', 'white', 'silver', 'blue', 'red'][(rand() * 5) | 0],
			weightGrams: (rand() * 20_000) | 0,
			dimensionsCm: [(rand() * 100) | 0, (rand() * 100) | 0, (rand() * 100) | 0],
			warehouse: 'WH-' + String((rand() * 40) | 0).padStart(3, '0'),
			certified: rand() > 0.5,
		},
	};
}

/**
 * Same shape and approximately the same serialized size as `realisticRecord`,
 * but every field is high-entropy — the incompressible control.
 */
function randomRecord(rand: () => number, _i: number): Record<string, unknown> {
	const tagCount = 1 + ((rand() * 4) | 0);
	const tags = new Array<string>(tagCount);
	for (let t = 0; t < tagCount; t++) tags[t] = randomString(rand, 9);
	return {
		sku: randomString(rand, 12),
		category: randomString(rand, 11),
		brand: randomString(rand, 12),
		region: randomString(rand, 12),
		status: randomString(rand, 10),
		currency: randomString(rand, 3),
		title: randomString(rand, 34),
		description: randomString(rand, 400),
		price: Math.round(rand() * 250_000) / 100,
		quantity: (rand() * 5000) | 0,
		rating: Math.round(rand() * 50) / 10,
		createdAt: randomString(rand, 24),
		updatedAt: randomString(rand, 24),
		tags,
		attributes: {
			color: randomString(rand, 6),
			weightGrams: (rand() * 20_000) | 0,
			dimensionsCm: [(rand() * 100) | 0, (rand() * 100) | 0, (rand() * 100) | 0],
			warehouse: randomString(rand, 6),
			certified: rand() > 0.5,
		},
	};
}

/**
 * Pre-serialize a pool of bodies. A pool (rather than one body per key) keeps
 * generation cost out of the measured loop while still giving the compressor
 * far more distinct content than it can memorize in a single block.
 */
function buildPayloadPool(dataset: string, size: number, seed: number): { bodies: Buffer[]; meanBytes: number } {
	const rand = mulberry32(seed);
	const make = dataset === 'random' ? randomRecord : realisticRecord;
	const bodies = new Array<Buffer>(size);
	let total = 0;
	for (let i = 0; i < size; i++) {
		const body = Buffer.from(JSON.stringify(make(rand, i)));
		bodies[i] = body;
		total += body.length;
	}
	return { bodies, meanBytes: total / size };
}

// ---------------------------------------------------------------------------
// HTTP driver
// ---------------------------------------------------------------------------

interface Endpoint {
	hostname: string;
	port: number;
	agent: http.Agent;
}

function request(ep: Endpoint, method: string, path: string, body?: Buffer): Promise<number> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = { accept: 'application/json' };
		if (body) {
			headers['content-type'] = 'application/json';
			headers['content-length'] = String(body.length);
		}
		const req = http.request(
			{ hostname: ep.hostname, port: ep.port, path, method, agent: ep.agent, headers },
			(res) => {
				let bytes = 0;
				res.on('data', (chunk: Buffer) => {
					bytes += chunk.length;
				});
				res.on('end', () => {
					const status = res.statusCode ?? 0;
					if (status >= 200 && status < 300) resolve(bytes);
					else reject(new Error(`${method} ${path} -> ${status}`));
				});
				res.on('error', reject);
			}
		);
		req.on('error', reject);
		req.setTimeout(60_000, () => req.destroy(new Error(`${method} ${path} timed out`)));
		if (body) req.write(body);
		req.end();
	});
}

interface PhaseResult {
	ops: number;
	errors: number;
	elapsedMs: number;
	throughput: number;
	p50Ms: number;
	p99Ms: number;
}

/** Closed-loop driver: `concurrency` workers each issue one request at a time. */
async function drive(
	ep: Endpoint,
	count: number,
	concurrency: number,
	issue: (index: number) => Promise<unknown>,
	record: boolean
): Promise<PhaseResult> {
	let dispatched = 0;
	let errors = 0;
	const latencies: number[] = [];

	const worker = async (): Promise<void> => {
		for (;;) {
			const index = dispatched++;
			if (index >= count) break;
			const t0 = performance.now();
			try {
				await issue(index);
				if (record) latencies.push(performance.now() - t0);
			} catch {
				errors++;
			}
		}
	};

	const start = performance.now();
	await Promise.all(Array.from({ length: concurrency }, worker));
	const elapsedMs = performance.now() - start;
	const ops = count - errors;
	latencies.sort((a, b) => a - b);
	const pick = (q: number) =>
		latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] : 0;
	return { ops, errors, elapsedMs, throughput: (ops * 1_000) / elapsedMs, p50Ms: pick(0.5), p99Ms: pick(0.99) };
}

// ---------------------------------------------------------------------------
// Disk accounting
//
// Only SST and blob files carry the column-family codec. The write-ahead log,
// Harper's transaction log, MANIFEST/OPTIONS/CURRENT and friends do not, so
// they are reported separately rather than folded into the ratio.
// ---------------------------------------------------------------------------

interface DiskUsage {
	sst: number;
	blob: number;
	wal: number;
	txnlog: number;
	other: number;
	total: number;
}

function classify(path: string): keyof Omit<DiskUsage, 'total'> {
	if (path.endsWith('.sst')) return 'sst';
	if (path.endsWith('.blob')) return 'blob';
	if (path.endsWith('.log')) return 'wal';
	if (path.includes('transaction-log') || path.includes('txnlog') || /\.seq\d*$/.test(path)) return 'txnlog';
	return 'other';
}

async function measureDisk(root: string): Promise<DiskUsage> {
	const usage: DiskUsage = { sst: 0, blob: 0, wal: 0, txnlog: 0, other: 0, total: 0 };
	const walk = async (dir: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile()) {
				try {
					// Apparent size, not allocated blocks: SST files are written
					// sequentially and fully packed, and apparent size is what a
					// backup or a replication stream actually moves.
					const s = await stat(full);
					usage[classify(full)] += s.size;
					usage.total += s.size;
				} catch {
					// file vanished mid-walk (compaction); ignore
				}
			}
		}
	};
	await walk(root);
	return usage;
}

// ---------------------------------------------------------------------------
// CPU accounting
// ---------------------------------------------------------------------------

const CLOCK_TICKS = 100; // _SC_CLK_TCK is 100 on every Linux Harper supports

/** Total CPU seconds (user + system) for `pid` and all of its descendants. */
async function processTreeCpuSeconds(pid: number): Promise<number> {
	if (process.platform !== 'linux') return NaN;
	const pids = await collectDescendants(pid);
	let ticks = 0;
	for (const p of pids) {
		try {
			const raw = await readFile(`/proc/${p}/stat`, 'utf8');
			// comm can contain spaces and parens; fields are positional after the last ')'
			const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
			ticks += Number(fields[11]) + Number(fields[12]); // utime, stime
		} catch {
			// process exited between listing and reading
		}
	}
	return ticks / CLOCK_TICKS;
}

async function collectDescendants(pid: number): Promise<number[]> {
	const out = [pid];
	const queue = [pid];
	while (queue.length) {
		const current = queue.pop()!;
		try {
			const children = (await readFile(`/proc/${current}/task/${current}/children`, 'utf8')).trim();
			if (!children) continue;
			for (const c of children.split(/\s+/).map(Number)) {
				out.push(c);
				queue.push(c);
			}
		} catch {
			// no children file or process gone
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Startup probe
// ---------------------------------------------------------------------------

async function waitForRoute(url: string, deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
			await res.body?.cancel();
			if (res.status >= 200 && res.status < 300) return;
		} catch {
			// not ready yet
		}
		await delay(250);
	}
	throw new Error(`timed out waiting for ${url}`);
}

// ---------------------------------------------------------------------------
// One codec × dataset run
// ---------------------------------------------------------------------------

interface RunResult {
	codec: string;
	dataset: string;
	records: number;
	meanRecordBytes: number;
	logicalBytes: number;
	insert: PhaseResult;
	update: PhaseResult;
	read: PhaseResult;
	scan: PhaseResult;
	scanBytesRead: number;
	/**
	 * Size as the workload left it. This is NOT a post-compaction steady state: the update phase
	 * leaves obsolete record versions behind, and Harper exposes no way to force a RocksDB
	 * compaction from outside the process (`storage.compactOnStart` is an LMDB copy-compact and
	 * does nothing here). Every codec runs the identical workload, so the comparison between them
	 * is sound; the absolute ratio against `logicalBytes` is inflated by that garbage.
	 */
	disk: DiskUsage;
	cpuSeconds: number;
	/** False when the instance shed enough load that the numbers describe backpressure, not the codec. */
	valid: boolean;
	errorRate: number;
}

async function runOne(opts: CliOptions, codec: string, dataset: string): Promise<RunResult> {
	const label = `${codec}/${dataset}`;
	console.log(`\n${'-'.repeat(72)}\n[${label}] starting Harper (fresh data dir)`);

	const ctx = createHarperContext(`compression-${codec}-${dataset}`);
	const config: Record<string, unknown> = {
		threads: { count: opts.threads },
		analytics: { aggregatePeriod: -1 },
		logging: { level: 'warn' },
		storage: {
			rocks: {
				// Pinned so the read phase actually misses cache and pays for
				// decompression; see the header note.
				blockCacheSize: opts.blockCacheBytes,
			},
		},
	};
	// The codec is selected by environment variable, not config. Harper's main thread loads the
	// storage layer during install, before a configured value is readable, while its worker threads
	// load it afterwards; they share one process-wide RocksDB column-family registry, so a config
	// value makes the threads disagree and the second open of `__dbis__` throws.
	const env = { HARPER_STORAGE_ENGINE: 'rocksdb', HARPER_STORAGE_ROCKS_COMPRESSION: codec };

	await setupHarperWithFixture(ctx, APP_DIR, {
		harperBinPath: HARPER_BIN,
		config,
		env,
		startupTimeoutMs: opts.startupTimeoutMs,
	});

	const started = ctx as { harper: { httpURL: string; dataRootDir: string; process: { pid?: number } } };
	const { httpURL, dataRootDir } = started.harper;
	const pid = started.harper.process.pid!;
	const parsed = new URL(httpURL);
	const ep: Endpoint = {
		hostname: parsed.hostname,
		port: Number(parsed.port) || 9926,
		agent: new http.Agent({ keepAlive: true, maxSockets: opts.concurrency, maxFreeSockets: opts.concurrency }),
	};

	try {
		await waitForRoute(`${httpURL}/records/`, 60_000);

		const cpuBefore = await processTreeCpuSeconds(pid);
		const POOL_SIZE = Math.min(opts.records, 20_000);
		const { bodies, meanBytes } = buildPayloadPool(dataset, POOL_SIZE, 0x5eed);
		const pad = String(opts.records + opts.warmup).length + 2;
		const key = (i: number) => 'key' + String(i).padStart(pad, '0');

		// Warmup: untimed, and written to a key range the measured phases never
		// touch, so it heats JIT/connections without seeding the measured set.
		if (opts.warmup > 0) {
			process.stdout.write(`[${label}] warmup ${opts.warmup.toLocaleString()} inserts...`);
			await drive(
				ep,
				opts.warmup,
				opts.concurrency,
				(i) => request(ep, 'PUT', `/records/w${key(i)}`, bodies[i % bodies.length]),
				false
			);
			process.stdout.write(' done\n');
		}

		process.stdout.write(`[${label}] insert ${opts.records.toLocaleString()}...`);
		const insert = await drive(
			ep,
			opts.records,
			opts.concurrency,
			(i) => request(ep, 'PUT', `/records/${key(i)}`, bodies[i % bodies.length]),
			true
		);
		process.stdout.write(` ${insert.throughput.toFixed(0)} ops/s\n`);

		// Read a uniformly-distributed key each time. Uniform (not zipfian) is
		// deliberate: a skewed distribution would sit in the block cache and hide
		// exactly the decompression cost this phase exists to measure.
		const readRand = mulberry32(0xf00d);
		process.stdout.write(`[${label}] read ${opts.reads.toLocaleString()}...`);
		const read = await drive(
			ep,
			opts.reads,
			opts.concurrency,
			() => request(ep, 'GET', `/records/${key((readRand() * opts.records) | 0)}`),
			true
		);
		process.stdout.write(` ${read.throughput.toFixed(0)} ops/s\n`);

		// Range scans over the primary key: sequential block reads, where
		// decompression throughput matters most.
		const scanRand = mulberry32(0xbeef);
		let scanBytesRead = 0;
		process.stdout.write(`[${label}] scan ${opts.scans.toLocaleString()} × 50...`);
		const scan = await drive(
			ep,
			opts.scans,
			opts.concurrency,
			async () => {
				const start = key(Math.max(0, ((scanRand() * opts.records) | 0) - 50));
				scanBytesRead += (await request(ep, 'GET', `/records/?id>=${start}&limit(50)`)) as number;
			},
			true
		);
		process.stdout.write(` ${scan.throughput.toFixed(0)} ops/s\n`);

		const updateRand = mulberry32(0xc0de);
		process.stdout.write(`[${label}] update ${opts.updates.toLocaleString()}...`);
		const update = await drive(
			ep,
			opts.updates,
			opts.concurrency,
			(i) => request(ep, 'PUT', `/records/${key((updateRand() * opts.records) | 0)}`, bodies[i % bodies.length]),
			true
		);
		process.stdout.write(` ${update.throughput.toFixed(0)} ops/s\n`);

		const cpuAfter = await processTreeCpuSeconds(pid);
		const cpuSeconds = cpuAfter - cpuBefore;
		ep.agent.destroy();

		// killHarper (not teardownHarper) — SIGTERM lets Harper flush memtables
		// and close the column families, and leaves dataRootDir in place, which
		// teardownHarper deletes.
		await killHarper(ctx as never);
		const disk = await measureDisk(dataRootDir);

		await teardownHarper(ctx as never);

		// Harper sheds load when commits back up (storage.maxTransactionQueueTime),
		// answering 503 rather than blocking. A run that tripped that measured
		// backpressure, not the codec — and its on-disk size is missing whatever
		// never landed, which would read as a spectacular compression ratio.
		const attempted = opts.records + opts.reads + opts.scans + opts.updates;
		const errors = insert.errors + read.errors + scan.errors + update.errors;
		const errorRate = errors / attempted;
		const valid = errorRate <= opts.maxErrorRate;
		if (!valid) {
			console.warn(
				`[${label}] INVALID: ${errors.toLocaleString()}/${attempted.toLocaleString()} requests failed ` +
					`(${(errorRate * 100).toFixed(1)}% > ${(opts.maxErrorRate * 100).toFixed(1)}% limit) — instance was shedding load`
			);
		}

		return {
			codec,
			dataset,
			records: opts.records,
			valid,
			errorRate,
			meanRecordBytes: meanBytes,
			// Warmup rows are written to the same table and drawn from the same
			// pool, so they belong in the logical total the ratio is taken against.
			logicalBytes: meanBytes * (opts.records + opts.warmup),
			insert,
			update,
			read,
			scan,
			scanBytesRead,
			disk,
			cpuSeconds,
		};
	} catch (error) {
		ep.agent.destroy();
		try {
			await teardownHarper(ctx as never);
		} catch {
			// teardown failure on an already-failing run is noise
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

function printReport(results: RunResult[]): void {
	for (const dataset of [...new Set(results.map((r) => r.dataset))]) {
		const rows = results.filter((r) => r.dataset === dataset);
		// Only a valid baseline can normalize anything; an invalid one would make
		// every other codec look wrong in the opposite direction.
		const baseline = rows.find((r) => r.codec === 'none' && r.valid);

		console.log(`\n${'='.repeat(100)}`);
		console.log(
			`dataset: ${dataset}   records: ${rows[0].records.toLocaleString()}   mean record: ${rows[0].meanRecordBytes.toFixed(0)} B JSON`
		);
		console.log('='.repeat(100));

		console.log(
			'codec'.padEnd(8) +
				'SST+blob'.padStart(11) +
				'ratio'.padStart(8) +
				'vs none'.padStart(9) +
				'insert/s'.padStart(11) +
				'update/s'.padStart(10) +
				'read/s'.padStart(10) +
				'read p99'.padStart(10) +
				'scan/s'.padStart(9) +
				'CPU s'.padStart(8)
		);
		for (const r of rows) {
			const dataBytes = r.disk.sst + r.disk.blob;
			const ratio = r.logicalBytes / dataBytes;
			const vsNone = baseline ? dataBytes / (baseline.disk.sst + baseline.disk.blob) : NaN;
			console.log(
				r.codec.padEnd(8) +
					`${mib(dataBytes)}M`.padStart(11) +
					`${ratio.toFixed(2)}x`.padStart(8) +
					(Number.isNaN(vsNone) ? '-'.padStart(9) : `${(vsNone * 100).toFixed(0)}%`.padStart(9)) +
					r.insert.throughput.toFixed(0).padStart(11) +
					r.update.throughput.toFixed(0).padStart(10) +
					r.read.throughput.toFixed(0).padStart(10) +
					`${r.read.p99Ms.toFixed(1)}ms`.padStart(10) +
					r.scan.throughput.toFixed(0).padStart(9) +
					r.cpuSeconds.toFixed(0).padStart(8) +
					(r.valid ? '' : `   <-- INVALID (${(r.errorRate * 100).toFixed(1)}% requests failed)`)
			);
		}

		console.log('\nnon-codec bytes, excluded from the ratio (identical work across codecs):');
		for (const r of rows) {
			console.log(
				`  ${r.codec.padEnd(8)} wal ${mib(r.disk.wal).padStart(6)}M   txnlog ${mib(r.disk.txnlog).padStart(7)}M   other ${mib(r.disk.other).padStart(6)}M   total on disk ${mib(r.disk.total).padStart(8)}M`
			);
		}

		for (const r of rows) {
			const dataBytes = r.disk.sst + r.disk.blob;
			console.log(
				`COMPRESSION_RESULT codec=${r.codec} dataset=${r.dataset} records=${r.records} ` +
					`sst_blob_bytes=${dataBytes} total_bytes=${r.disk.total} logical_bytes=${Math.round(r.logicalBytes)} ` +
					`insert_ops_per_sec=${r.insert.throughput.toFixed(0)} update_ops_per_sec=${r.update.throughput.toFixed(0)} ` +
					`read_ops_per_sec=${r.read.throughput.toFixed(0)} read_p99_ms=${r.read.p99Ms.toFixed(2)} ` +
					`scan_ops_per_sec=${r.scan.throughput.toFixed(0)} cpu_seconds=${r.cpuSeconds.toFixed(1)} ` +
					`errors=${r.insert.errors + r.read.errors + r.scan.errors + r.update.errors} valid=${r.valid}`
			);
		}
	}
}

function gitInfo(): { commit: string; branch: string } {
	const read = (args: string[]) => {
		try {
			return execFileSync('git', args, { encoding: 'utf8', cwd: REPO_ROOT }).trim();
		} catch {
			return 'unknown';
		}
	};
	return { commit: read(['rev-parse', 'HEAD']), branch: read(['rev-parse', '--abbrev-ref', 'HEAD']) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const opts = parseOptions();
	await mkdir(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR!, { recursive: true });

	const { supportedCompression } = await import('@harperfast/rocksdb-js');
	const unsupported = opts.codecs.filter((c) => !supportedCompression.includes(c));
	if (unsupported.length) {
		throw new Error(
			`codec(s) not compiled into this rocksdb-js build: ${unsupported.join(', ')}. Supported: ${supportedCompression.join(', ')}`
		);
	}

	console.log('='.repeat(100));
	console.log('Harper RocksDB compression comparison');
	console.log(
		`codecs=${opts.codecs.join(',')}  datasets=${opts.datasets.join(',')}  records=${opts.records.toLocaleString()}`
	);
	console.log(`concurrency=${opts.concurrency}  threads=${opts.threads}  blockCache=${mib(opts.blockCacheBytes)}MiB`);
	console.log(`rocksdb-js supports: ${supportedCompression.join(', ')}`);
	console.log('='.repeat(100));

	const results: RunResult[] = [];
	let first = true;
	for (const dataset of opts.datasets) {
		for (const codec of opts.codecs) {
			// Tearing down an instance deletes a multi-gigabyte tree, and the run
			// before it left that much dirty page cache behind. Starting the next
			// instance straight into that writeback backlog stalls its very first
			// commits past Harper's queue limit, which shows up as a "slow codec"
			// when it is really the previous run still hitting the disk. Flush and
			// let the device drain first.
			if (!first && opts.settleSeconds > 0) {
				process.stdout.write(`\n[settle] sync + ${opts.settleSeconds}s quiesce...`);
				try {
					execFileSync('sync');
				} catch {
					// non-fatal: the quiesce delay alone still helps
				}
				await delay(opts.settleSeconds * 1_000);
				process.stdout.write(' done\n');
			}
			first = false;
			results.push(await runOne(opts, codec, dataset));
		}
	}

	printReport(results);

	await mkdir(opts.out, { recursive: true });
	const outFile = join(opts.out, `compression-${Date.now()}.json`);
	await writeFile(
		outFile,
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				git: gitInfo(),
				node: process.version,
				options: opts,
				supportedCompression,
				results,
			},
			null,
			2
		)
	);
	console.log(`\nresults written to ${outFile}`);
}

await main();
