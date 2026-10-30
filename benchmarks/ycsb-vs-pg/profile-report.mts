/**
 * Where each target's CPU per op goes, from the profiled windows of a run-compare or memory-sweep
 * results file (--profile). Every sampled stack is put in one bucket: GC and JIT compilation by any
 * frame on the stack, everything else by its innermost recognized frame, so a builtin or malloc is
 * charged to the code that called it. A bucket's µs/op is its share of a component's samples times
 * that component's cgroup CPU per op in the same window.
 *
 *   node benchmarks/ycsb-vs-pg/profile-report.mts results/compare-latest.json [--svg-dir=<dir>]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readFolded } from './perfProfile.mts';
import type { Counters } from './perfProfile.mts';
import type { ProfiledWindow } from './run-compare.mts';

export const BUCKETS = {
	'http': 'HTTP parse + write, socket I/O and syscalls',
	'routing': 'routing, request/context setup, handler',
	'auth': 'authentication, permissions',
	'txn': 'Resource/Table.get, transactions',
	'record-cache': 'record cache lookup',
	'rocksdb': 'RocksDB read',
	'decode': 'record decode',
	'serialize': 'response serialization (JSON)',
	'cache-client': 'Redis client (ioredis)',
	'redis-server': 'Redis server',
	'pg-client': 'Postgres client',
	'postgres-server': 'Postgres server',
	'event-loop': 'event loop, promise/microtask machinery',
	'gc': 'GC',
	'jit': 'JIT compilation',
	'other': 'other',
} as const;
export type Bucket = keyof typeof BUCKETS;

const GC =
	/Scavenger|MarkCompactCollector|ConcurrentMarking|Sweeper::|MarkingVisitor|IncrementalMarking|Heap::CollectGarbage|Heap::PerformGarbageCollection|MinorMarkSweep|Heap::Scavenge|MarkingBarrier|Evacuat|PointersUpdating|ArrayBufferSweeper|Heap::StartIncrementalMarking|cppgc::internal::(Marker|Sweeper)|GCTracer/;
const JIT =
	/v8::internal::compiler::|v8::internal::maglev::|v8::internal::turboshaft::|OptimizingCompileDispatcher|Compiler::Compile|baseline::BaselineCompiler|v8::internal::interpreter::BytecodeGenerator/;

const JS_FILE_RULES: [RegExp, Bucket][] = [
	[/\/serverHelpers\/uwsServer\.js/, 'http'],
	[/\/serverHelpers\/contentTypes\.js|\/serverHelpers\/JSONStream/, 'serialize'],
	[/\/dist\/security\//, 'auth'],
	[/\/node_modules\/weak-lru-cache\//, 'record-cache'],
	[/\/dist\/resources\/RecordEncoder\.js|\/node_modules\/(msgpackr|structon|cbor-x)\//, 'decode'],
	[/\/dist\/resources\/PrimaryRocksDatabase\.js|\/node_modules\/@harperfast\/rocksdb-js\//, 'rocksdb'],
	[/\/dist\/resources\/(Resource|RequestTarget|Resources|ResourceInterface)\.js|\/dist\/server\//, 'routing'],
	[/\/dist\/resources\//, 'txn'],
	[/\/node_modules\/(fast-json-stringify|secure-json-parse)\//, 'serialize'],
	[
		/\/node_modules\/(fastify|find-my-way|avvio|@fastify|fastq|light-my-request|abstract-logging|pino|toad-cache|process-warning|rfdc)\/|\/pg-app\/server\.mjs/,
		'routing',
	],
	[
		/\/node_modules\/(ioredis|redis-parser|redis-errors|cluster-key-slot|denque|standard-as-callback)\//,
		'cache-client',
	],
	[
		/\/node_modules\/(pg|pg-protocol|pg-pool|pg-types|pg-cloudflare|pgpass|pg-connection-string|postgres-\w+)\//,
		'pg-client',
	],
	[/node:(internal\/)?(_?http|net|stream|internal\/streams|internal\/stream_base_commons|_http_\w+)/, 'http'],
];

const NATIVE_RULES: [RegExp, Bucket][] = [
	[/[([]uws_linux_[^)\]]*\.node[)\]]|^uWS::|^us_/, 'http'],
	[/[([]node\.napi\.glibc\.node[)\]]|Extractor::/, 'decode'],
	[/VerificationTable|verification_table/, 'record-cache'],
	[
		/rocksdb_js::(Transaction|TransactionHandle)\b|rocksdb_js::DBDescriptor::transaction|rocksdb::(Pessimistic|Optimistic)?Transaction(DB)?(Impl|BaseImpl)?::(Commit|Rollback|~|Initialize|Clear|SetSnapshot)/,
		'txn',
	],
	[/[([]rocksdb-js\.node[)\]]/, 'rocksdb'],
	[/JsonStringifier|Builtins_JsonStringify|JsonStringify/, 'serialize'],
	[
		/llhttp|node::\(anonymous namespace\)::Parser|node::StreamBase|LibuvStreamWrap|uv__write|uv__read|uv__stream_io|uv_try_write|node::TCPWrap|WriteWrap|node::StreamReq/,
		'http',
	],
	[
		/RunMicrotasks|MicrotaskQueue|PromiseFulfillReactionJob|InternalCallbackScope|InternalMakeCallback|uv__io_poll|uv_run|epoll_p?wait|uv__run_check|uv__run_idle/,
		'event-loop',
	],
];

// JIT'd JS: "<tier marker><name> <url>:<line>:<col>"; builtins and native frames carry a "(dso)" suffix.
const JS_FRAME = / ((?:file:\/\/)?\/[^ ]+|node:[^ ]+):\d+:\d+$/;
const isJsFrame = (frame: string) => JS_FRAME.test(frame);

/** The bucket a single frame claims, or undefined to defer to its caller. */
export function frameBucket(frame: string): Bucket | undefined {
	const js = JS_FRAME.exec(frame);
	if (js) {
		for (const [pattern, bucket] of JS_FILE_RULES) if (pattern.test(js[1])) return bucket;
		return undefined;
	}
	for (const [pattern, bucket] of NATIVE_RULES) if (pattern.test(frame)) return bucket;
	return undefined;
}

export function classify(stack: string[], component: string): Bucket {
	if (component === 'redis') return 'redis-server';
	if (component === 'postgres') return 'postgres-server';
	if (stack.some((f) => GC.test(f))) return 'gc';
	if (stack.some((f) => JIT.test(f))) return 'jit';
	for (let i = stack.length - 1; i >= 0; i--) {
		const bucket = frameBucket(stack[i]);
		if (!bucket) continue;
		// Node's socket layer serves the database clients' connections too, so a socket write belongs to
		// the nearest recognized JS caller: a client's, or HTTP's. Not any ancestor: a handler resumed
		// from an await runs inside the client's data callback, under the client's frames. (A read is
		// not attributable: libuv reads before any JS on the stack says whose socket it was.)
		if (bucket === 'http' && !/uws|uWS|us_/.test(stack[i])) {
			for (let j = i - 1; j >= 0; j--) {
				const owner = frameBucket(stack[j]);
				if (!owner || !isJsFrame(stack[j])) continue;
				if (owner === 'cache-client' || owner === 'pg-client') return owner;
				break;
			}
		}
		return bucket;
	}
	return 'other';
}

const ROCKSDB_PARTS: [RegExp, string][] = [
	[
		/LRUCache|lru_cache|ShardedCache|ClockCache|HyperClock|Cache::Lookup|CacheHandleGuard|BlockBasedTable::.*Cache/,
		'block cache lookup',
	],
	[/MemTable|InlineSkipList|SkipList/, 'memtable'],
	[/LZ4|Snappy|ZSTD|Uncompress|Decompress|zlib/i, 'decompression'],
	[
		/RandomAccessFile|FSRandomAccess|PosixRandomAccess|BlockFetcher|ReadBlockContents|^pread|\bpread64/,
		'file read (block cache miss)',
	],
	[/Filter|Bloom/, 'filter'],
	[/BlockIter|IndexReader|BinarySeek|GetRestartKey|SeekToRestartPoint/, 'index/data block search'],
	[
		/Version::Get|TableCache|GetContext|BlockBasedTable::Get|DBImpl::GetImpl|SuperVersion/,
		'SST get, version, superversion',
	],
	[/rocksdb_js::/, 'rocksdb-js binding'],
];

/** The RocksDB sub-part a sample in the rocksdb bucket spent its time in, by its innermost matching frame. */
export function rocksdbPart(stack: string[]): string {
	for (let i = stack.length - 1; i >= 0; i--) {
		for (const [pattern, part] of ROCKSDB_PARTS) if (pattern.test(stack[i])) return part;
	}
	return 'JS glue, napi, other';
}

interface ProfileRow {
	label: string;
	file: string;
	target: string;
	workload: string;
	point: string;
	profile: ProfiledWindow;
	/** bucket -> µs/op */
	microsPerOp: Record<string, number>;
	/** bucket -> µs/op in kernel mode */
	kernelMicrosPerOp: Record<string, number>;
	rocksdbParts: Record<string, number>;
	topSelf: Record<string, [string, number][]>;
}

const shortFrame = (f: string) =>
	f
		.replace(/(file:\/\/)?\/\S*?\/(dist|node_modules|benchmarks)\//, '$2/')
		.replace(/\s+\([^)]*\)$/, (m) => (m.includes('.so') || m.includes('.node') ? m : ''));

async function analyze(
	profile: ProfiledWindow
): Promise<Omit<ProfileRow, 'label' | 'file' | 'target' | 'workload' | 'point' | 'profile'>> {
	const microsPerOp: Record<string, number> = {};
	const kernelMicrosPerOp: Record<string, number> = {};
	const rocksdbParts: Record<string, number> = {};
	const topSelf: Record<string, Map<string, number>> = {};
	for (const [component, samples] of Object.entries(profile.samples)) {
		if (samples === 0) continue;
		const componentMicrosPerOp = ((profile.byComponentCpuSeconds[component] ?? 0) * 1e6) / profile.ops;
		const perSample = componentMicrosPerOp / samples;
		for (const { stack, count } of await readFolded(`${profile.prefix}.${component}.folded`)) {
			const bucket = classify(stack, component);
			const us = count * perSample;
			microsPerOp[bucket] = (microsPerOp[bucket] ?? 0) + us;
			if (stack[stack.length - 1] === '[kernel]') kernelMicrosPerOp[bucket] = (kernelMicrosPerOp[bucket] ?? 0) + us;
			if (bucket === 'rocksdb') {
				const part = rocksdbPart(stack);
				rocksdbParts[part] = (rocksdbParts[part] ?? 0) + us;
			}
			// The innermost frame that is not kernel, libc or a V8 builtin: what to look at first.
			let leaf = stack.length - 1;
			while (leaf > 0 && /^\[kernel\]$|\(libc\.so|^Builtins_|\(ld-linux/.test(stack[leaf])) leaf--;
			const map = (topSelf[bucket] ??= new Map());
			const name = shortFrame(stack[leaf]);
			map.set(name, (map.get(name) ?? 0) + us);
		}
	}
	return {
		microsPerOp,
		kernelMicrosPerOp,
		rocksdbParts,
		topSelf: Object.fromEntries(
			Object.entries(topSelf).map(([bucket, map]) => [bucket, [...map].sort((a, b) => b[1] - a[1]).slice(0, 8)])
		),
	};
}

function counterLine(total: Counters, ops: number): string {
	const instructions = total.instructionsUser + total.instructionsKernel;
	const cycles = total.cyclesUser + total.cyclesKernel;
	return [
		`${(instructions / ops / 1000).toFixed(1)}k instr/op`,
		`(${((100 * total.instructionsKernel) / instructions).toFixed(0)}% kernel)`,
		`${(cycles / ops / 1000).toFixed(1)}k cycles/op`,
		`IPC ${(instructions / cycles).toFixed(2)}`,
		`${(total.contextSwitches / ops).toFixed(3)} ctx-sw/op`,
		`${(total.pageFaults / ops).toFixed(3)} faults/op`,
	].join(', ');
}

// --- flame graph -------------------------------------------------------------------------------

interface FlameNode {
	name: string;
	value: number;
	children: Map<string, FlameNode>;
}

const BUCKET_COLORS: Record<Bucket, string> = {
	'http': '#e8a33d',
	'routing': '#d4c35a',
	'auth': '#c97b63',
	'txn': '#7aa6c2',
	'record-cache': '#5bb5a2',
	'rocksdb': '#4f86c6',
	'decode': '#9b7fc4',
	'serialize': '#c47fb0',
	'cache-client': '#e07a5f',
	'redis-server': '#d1495b',
	'pg-client': '#6c8ebf',
	'postgres-server': '#336791',
	'event-loop': '#b0b0b0',
	'gc': '#8fbf6a',
	'jit': '#7fbf3f',
	'other': '#d9d9d9',
};

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A static SVG flame graph (root at the bottom), colored by each frame's own bucket. */
export function flameGraphSvg(stacks: { stack: string[]; count: number }[], title: string, width = 1600): string {
	const root: FlameNode = { name: 'all', value: 0, children: new Map() };
	for (const { stack, count } of stacks) {
		root.value += count;
		let node = root;
		for (const frame of stack) {
			let child = node.children.get(frame);
			if (!child) node.children.set(frame, (child = { name: frame, value: 0, children: new Map() }));
			child.value += count;
			node = child;
		}
	}
	const rowHeight = 16;
	const minWidth = 0.3;
	const rects: string[] = [];
	let maxDepth = 0;
	const scale = (width - 20) / Math.max(1, root.value);
	const walk = (node: FlameNode, x: number, depth: number, inherited: Bucket) => {
		const w = node.value * scale;
		if (w < minWidth) return;
		maxDepth = Math.max(maxDepth, depth);
		const own = node === root ? 'other' : (frameBucket(node.name) ?? (GC.test(node.name) ? 'gc' : inherited));
		rects.push(
			`<g><title>${escapeXml(shortFrame(node.name))} (${((100 * node.value) / root.value).toFixed(2)}%)</title>` +
				`<rect x="${(10 + x).toFixed(1)}" y="D${depth}" width="${w.toFixed(1)}" height="${rowHeight - 1}" fill="${BUCKET_COLORS[own]}"/>` +
				(w > 40
					? `<text x="${(13 + x).toFixed(1)}" y="T${depth}">${escapeXml(shortFrame(node.name).slice(0, Math.floor(w / 6.5)))}</text>`
					: '') +
				'</g>'
		);
		let offset = x;
		for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
			walk(child, offset, depth + 1, own);
			offset += child.value * scale;
		}
	};
	walk(root, 0, 0, 'other');
	const height = (maxDepth + 1) * rowHeight + 60;
	const y = (depth: number) => height - 30 - (depth + 1) * rowHeight;
	const legend = Object.entries(BUCKET_COLORS)
		.map(
			([bucket, color], i) =>
				`<rect x="${10 + i * 98}" y="${height - 22}" width="10" height="10" fill="${color}"/><text x="${23 + i * 98}" y="${height - 13}">${bucket}</text>`
		)
		.join('');
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="monospace" font-size="11">` +
		`<rect width="100%" height="100%" fill="#ffffff"/><text x="10" y="18" font-size="14">${escapeXml(title)}</text>` +
		rects
			.join('')
			.replace(
				/y="([DT])(\d+)"/g,
				(_, kind, depth) => `y="${kind === 'D' ? y(Number(depth)) : y(Number(depth)) + 11}"`
			) +
		legend +
		'</svg>'
	);
}

// --- report ------------------------------------------------------------------------------------

interface ResultSample {
	target: string;
	workload: string;
	ratio?: number;
	rep: number;
	measured?: { profile?: ProfiledWindow };
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const svgDir = argv.find((a) => a.startsWith('--svg-dir='))?.slice('--svg-dir='.length);
	const files = argv.filter((a) => !a.startsWith('--'));
	if (files.length === 0) throw new Error('usage: profile-report.mts <results.json>... [--svg-dir=<dir>]');
	if (svgDir) await mkdir(svgDir, { recursive: true });
	const rows: ProfileRow[] = [];
	for (const file of files) {
		const results = JSON.parse(await readFile(file, 'utf8'));
		for (const sample of results.samples as ResultSample[]) {
			const profile = sample.measured?.profile;
			if (!profile) continue;
			const point = sample.ratio === undefined ? 'warm' : `${sample.ratio}x`;
			const label = basename(profile.prefix);
			rows.push({
				label,
				file,
				target: sample.target,
				workload: sample.workload,
				point,
				profile,
				...(await analyze(profile)),
			});
			if (svgDir) {
				const stacks: { stack: string[]; count: number }[] = [];
				for (const component of Object.keys(profile.samples)) {
					if (profile.samples[component] === 0) continue;
					for (const s of await readFolded(`${profile.prefix}.${component}.folded`)) {
						stacks.push({ stack: [component, ...s.stack], count: s.count });
					}
				}
				const title = `${sample.target} ${sample.workload} ${point}: ${profile.cpuMicrosPerOp.toFixed(1)} CPU µs/op at ${profile.throughput.toFixed(0)} ops/s`;
				await writeFile(join(svgDir, `${label}.svg`), flameGraphSvg(stacks, title));
			}
		}
	}
	const out: string[] = [];
	const buckets = Object.keys(BUCKETS) as Bucket[];
	const used = buckets.filter((b) => rows.some((r) => (r.microsPerOp[b] ?? 0) >= 0.05));
	out.push(`| bucket | ${rows.map((r) => `${r.target} ${r.workload} ${r.point}`).join(' | ')} |`);
	out.push(`|---|${rows.map(() => '--:').join('|')}|`);
	for (const bucket of used) {
		out.push(
			`| ${BUCKETS[bucket]} | ${rows
				.map((r) => {
					const us = r.microsPerOp[bucket] ?? 0;
					const kernel = r.kernelMicrosPerOp[bucket] ?? 0;
					return us < 0.05 ? '–' : `${us.toFixed(1)}${kernel >= 0.5 ? ` (${kernel.toFixed(1)} kernel)` : ''}`;
				})
				.join(' | ')} |`
		);
	}
	out.push(`| **total CPU µs/op** | ${rows.map((r) => `**${r.profile.cpuMicrosPerOp.toFixed(1)}**`).join(' | ')} |`);
	out.push(`| throughput, ops/s | ${rows.map((r) => r.profile.throughput.toFixed(0)).join(' | ')} |`);
	out.push('');
	for (const r of rows) {
		out.push(`### ${r.label}`);
		if (r.profile.steady)
			out.push(
				`steady window: ${r.profile.steady.cpuMicrosPerOp.toFixed(1)} CPU µs/op, ${counterLine(r.profile.steady.perf.total, r.profile.steady.ops)}`
			);
		if (r.profile.steady) {
			for (const [component, counters] of Object.entries(r.profile.steady.perf.byComponent)) {
				out.push(`- ${component}: ${counterLine(counters, r.profile.steady.ops)}`);
			}
		}
		const parts = Object.entries(r.rocksdbParts).sort((a, b) => b[1] - a[1]);
		if (parts.length > 0) out.push(`RocksDB read: ${parts.map(([p, us]) => `${p} ${us.toFixed(1)}`).join(', ')} µs/op`);
		for (const bucket of used) {
			const top = r.topSelf[bucket];
			if (!top || (r.microsPerOp[bucket] ?? 0) < 1) continue;
			out.push(`- ${bucket}: ${top.map(([name, us]) => `${name} ${us.toFixed(1)}`).join('; ')}`);
		}
		out.push('');
	}
	process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
