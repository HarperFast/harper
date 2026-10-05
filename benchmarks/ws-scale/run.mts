/**
 * WebSocket scale benchmark: per-connection / per-subscription memory, connect cost, and fan-out
 * delivery cost, reported as unit costs that can be turned into per-node capacity estimates.
 *
 * Harper and the load generators are pinned to disjoint CPU sets so Harper's CPU use can be read
 * from /proc without the clients' share. Clients spread connections across 127.0.1.x source
 * addresses to get past the ~28k ephemeral ports available per (source, destination) pair.
 *
 * Scenarios:
 *   conns   Ramp to each --steps connection count with --subs subscriptions per connection. Reports
 *           RSS / heap per connection, connect rate and CPU per connect, and idle CPU (keepalives).
 *   fanout  Hold --conns connections × --subs subscriptions over --topics topics, then publish at
 *           each --rates rate. Reports deliveries/s, CPU µs per delivery, and end-to-end latency.
 *   churn   Open --conns connections, disconnect them all (--close=graceful|abrupt), and repeat for --cycles
 *           cycles. Reports memory released per connection and memory still held after each disconnect.
 *
 * Usage (see README.md; after `npm run build` from the repo root):
 *   node benchmarks/ws-scale/run.mts --scenario=conns --steps=10000,50000,100000 --subs=0
 *   node benchmarks/ws-scale/run.mts --scenario=fanout --conns=20000 --topics=1 --rates=1,10,50 --payload=1000
 *
 * Harper-side CPU is Harper alone: no TLS (as behind a TLS-terminating proxy).
 */
import { parseArgs } from 'node:util';
import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statfsSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import {
	createHarperContext,
	setupHarperWithFixture,
	teardownHarper,
	sendOperation,
} from '@harperfast/integration-testing';

const HARPER_BIN = join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
const TMPFS_MAGIC = 0x01021994;
const APP_DIR = join(import.meta.dirname, 'app');
const CLIENT = join(import.meta.dirname, 'client.mts');
const CLK_TCK = 100;
const HIST_SCALE = 8;

const { values: args } = parseArgs({
	options: {
		'scenario': { type: 'string', default: 'conns' },
		'protocol': { type: 'string', default: 'mqtt' },
		'threads': { type: 'string', default: '8' },
		// defaults: Harper on the first --threads CPUs, load generators on the rest
		'harper-cpus': { type: 'string' },
		'client-cpus': { type: 'string' },
		'clients': { type: 'string', default: '8' },
		'source-ips': { type: 'string', default: '16' },
		'steps': { type: 'string', default: '10000,25000,50000' },
		'cycles': { type: 'string', default: '5' },
		'close': { type: 'string', default: 'graceful' },
		'conns': { type: 'string', default: '10000' },
		'subs': { type: 'string', default: '1' },
		'topics': { type: 'string', default: '1' },
		'rates': { type: 'string', default: '1,10,100' },
		'payload': { type: 'string', default: '200' },
		'publish': { type: 'string', default: 'mqtt' },
		'duration': { type: 'string', default: '20' },
		'settle': { type: 'string', default: '15' },
		'keepalive': { type: 'string', default: '60' },
		'concurrency': { type: 'string', default: '100' },
		'slow-fraction': { type: 'string', default: '0' },
		// publishing processes (and, for MQTT, connections) the rate is split across
		'publishers': { type: 'string', default: '1' },
		// with --publish=put, every PUT creates a new record (no topic records are pre-created)
		'insert': { type: 'boolean', default: false },
		'uws': { type: 'boolean', default: false },
		// another build's dist/bin/harper.js, for A/B runs of a change under the same harness
		'harper-bin': { type: 'string', default: HARPER_BIN },
		// subscribers connect over Harper's per-worker Unix socket mirrors, as a TLS-terminating proxy would
		'uds': { type: 'boolean', default: false },
		'log-level': { type: 'string', default: 'warn' },
		// CPU-profile every HTTP worker for this many seconds, starting 5s into the first fanout rate or at
		// the start of the last conns step's settle window; profiles land in --profile-dir
		'profile': { type: 'string' },
		'profile-dir': { type: 'string' },
		'harper-env': { type: 'string', multiple: true, default: [] },
		'engine': { type: 'string', default: 'rocksdb' },
		'label': { type: 'string', default: '' },
		'out': { type: 'string' },
	},
});

if (process.platform !== 'linux') throw new Error('ws-scale needs Linux: it reads /proc and pins CPUs with taskset');
const threads = Number(args.threads);
if (!Number.isInteger(threads) || threads < 1) throw new Error('--threads must be a positive integer');
function parseCpuList(list: string) {
	return list.split(',').flatMap((range) => {
		const [from, to = from] = range.split('-').map(Number);
		return Array.from({ length: to - from + 1 }, (_, i) => from + i);
	});
}
function allowedCpus() {
	return parseCpuList(/Cpus_allowed_list:\s*(\S+)/.exec(readFileSync('/proc/self/status', 'utf8'))![1]);
}
const cpus = allowedCpus();
if (cpus.length <= threads)
	throw new Error(`need more than --threads=${threads} CPUs to keep load generators off Harper's CPUs`);
args['harper-cpus'] ??= cpus.slice(0, threads).join(',');
args['client-cpus'] ??= cpus.slice(threads).join(',');
const harperCpus = parseCpuList(args['harper-cpus']!);
const clientCpus = parseCpuList(args['client-cpus']!);
for (const cpu of [...harperCpus, ...clientCpus])
	if (!cpus.includes(cpu)) throw new Error(`CPU ${cpu} is not in this process's allowed set (${cpus.join(',')})`);
if (harperCpus.some((cpu) => clientCpus.includes(cpu)))
	throw new Error('--harper-cpus and --client-cpus overlap, so load generators would run on Harper CPUs');
// this process coordinates the load generators and uses most of a core at high rates
pin(process.pid, args['client-cpus']!);
function cpufreqMHz(cpu: number, file: string) {
	const path = `/sys/devices/system/cpu/cpu${cpu}/cpufreq/${file}`;
	return existsSync(path) ? Number(readFileSync(path, 'utf8')) / 1000 : undefined;
}
// cycle-normalized fields assume every Harper CPU is pinned: min and max both set to one frequency
const cpuMaxMHz = cpufreqMHz(harperCpus[0], 'scaling_max_freq');
const cpuMinMHz = cpufreqMHz(harperCpus[0], 'scaling_min_freq');
const clockPinned =
	cpuMaxMHz !== undefined &&
	harperCpus.every(
		(cpu) => cpufreqMHz(cpu, 'scaling_min_freq') === cpuMaxMHz && cpufreqMHz(cpu, 'scaling_max_freq') === cpuMaxMHz
	);
if (!clockPinned)
	console.warn(
		`CPU clock is not pinned (min ${cpuMinMHz ?? '?'} MHz, max ${cpuMaxMHz ?? '?'} MHz); cpuKCyclesPer* fields are omitted`
	);
const installParent = process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir();
if (statfsSync(installParent).type === TMPFS_MAGIC)
	throw new Error(
		`${installParent} is tmpfs, which skews storage costs; set TMPDIR or HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR to a disk-backed directory`
	);
const clientCount = Number(args.clients);
const protocol = args.protocol as 'mqtt' | 'ws';
const subs = protocol === 'ws' ? 1 : Number(args.subs);
const topics = Number(args.topics);
if (subs > topics) throw new Error(`--subs=${subs} needs at least as many --topics, or a connection repeats a topic`);
if (args.insert && args.publish !== 'put') throw new Error('--insert applies only to --publish=put');
if (!['graceful', 'abrupt'].includes(args.close!)) throw new Error('--close must be graceful or abrupt');
if (args.scenario === 'churn' && args.profile) throw new Error('--profile applies to conns and fanout, not churn');
if (args.profile && (!Number.isFinite(Number(args.profile)) || Number(args.profile) <= 0))
	throw new Error('--profile must be a positive duration in seconds');
if (args.scenario === 'churn') {
	if (!Number.isInteger(Number(args.cycles)) || Number(args.cycles) < 1)
		throw new Error('--cycles must be a positive integer for churn');
	if (!Number.isInteger(Number(args.conns)) || Number(args.conns) < 1)
		throw new Error('--conns must be a positive integer for churn');
}
if (args.uds) {
	// Linux caps a Unix socket path at 107 bytes, and Harper skips (Node) or fails to start (uWS) a longer mirror
	const longestPath = join(installParent, 'harper-integration-test-XXXXXX', 'sockets', `${threads - 1}-9927-h2.sock`);
	if (Buffer.byteLength(longestPath) > 107)
		throw new Error(
			`UDS mirror paths under ${installParent} would exceed the 107-byte limit; set HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR to a shorter directory`
		);
}
const sourceIps = Array.from({ length: Number(args['source-ips']) }, (_, i) => `127.0.1.${i + 1}`);

function cpuTicks(pid: number) {
	const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
	const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
	return Number(fields[11]) + Number(fields[12]); // utime + stime
}
function rssMB(pid: number) {
	const match = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
	return Number(match![1]) / 1024;
}
function writeBytes(pid: number) {
	return Number(/write_bytes:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/io`, 'utf8'))![1]);
}
function pin(pid: number, cpus: string) {
	execFileSync('taskset', ['-a', '-p', '-c', cpus, String(pid)], { stdio: 'ignore' });
}

let ctx: any;
async function heapMB() {
	const info = await sendOperation(ctx.harper, { operation: 'system_information', attributes: ['threads'] });
	let used = 0;
	let total = 0;
	for (const thread of info.threads ?? []) {
		used += thread.heapUsed ?? 0;
		total += thread.heapTotal ?? 0;
	}
	return { used: used / 2 ** 20, total: total / 2 ** 20 };
}

async function liveHttpWorkerIds() {
	const response = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ operation: 'system_information', attributes: ['threads'] }),
		signal: AbortSignal.timeout(30_000),
	});
	const info = await response.json();
	if (!response.ok) throw new Error(`system_information returned HTTP ${response.status}: ${JSON.stringify(info)}`);
	return new Set(
		(info.threads ?? []).filter((thread: any) => thread.name === 'http').map((thread: any) => String(thread.threadId))
	);
}

class Client {
	child: ChildProcess;
	pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	exited = false;
	lastError?: Error;
	constructor() {
		this.child = fork(CLIENT, [], { execArgv: ['--max-old-space-size=8192'], stdio: 'inherit' });
		pin(this.child.pid!, args['client-cpus']!);
		this.child.on('message', (message: any) => {
			const pending = this.pending.get(message.reply);
			this.pending.delete(message.reply);
			if (message.error) pending?.reject(new Error(`load generator ${message.reply} failed: ${message.error}`));
			else pending?.resolve(message);
		});
		this.child.on('error', (error) => (this.lastError = error));
		this.child.on('exit', (code, signal) => {
			this.exited = true;
			for (const { reject } of this.pending.values())
				reject(
					new Error(`load generator exited (${signal ?? code}) with a request pending`, { cause: this.lastError })
				);
			this.pending.clear();
		});
	}
	request(message: any): Promise<any> {
		if (this.exited) return Promise.reject(new Error('load generator has exited'));
		return new Promise((resolve, reject) => {
			this.pending.set(message.cmd, { resolve, reject });
			this.child.send(message);
		});
	}
}

function sumStats(all: any[]) {
	const total: any = { latencyHist: [] };
	for (const stats of all) {
		for (const [key, value] of Object.entries(stats)) {
			if (key === 'latencyHist')
				(value as number[]).forEach((count, i) => (total.latencyHist[i] = (total.latencyHist[i] ?? 0) + count));
			else if (typeof value === 'number') total[key] = (total[key] ?? 0) + value;
			else if (key === 'lastError' && value) total.lastError = value;
			else if (key === 'closeCodes') {
				total.closeCodes ??= {};
				for (const [code, count] of Object.entries(value as Record<string, number>))
					total.closeCodes[code] = (total.closeCodes[code] ?? 0) + count;
			}
		}
	}
	return total;
}

function percentiles(hist: number[], ps: number[]) {
	const count = hist.reduce((a, b) => a + b, 0);
	return ps.map((p) => {
		if (!count) return NaN;
		let seen = 0;
		for (let i = 0; i < hist.length; i++) {
			seen += hist[i] ?? 0;
			if (seen >= count * p) return (2 ** ((i + 1) / HIST_SCALE) - 1) / 1000; // bucket upper bound, ms
		}
		return NaN;
	});
}

const results: any[] = [];
function report(row: Record<string, unknown>) {
	row.cpuMaxMHz = cpuMaxMHz;
	row.clockPinned = clockPinned;
	if (clockPinned) {
		for (const [key, value] of Object.entries(row)) {
			if (key.startsWith('cpuUsPer') && typeof value === 'number')
				row[key.replace('cpuUsPer', 'cpuKCyclesPer')] = (value * cpuMaxMHz) / 1000;
		}
	}
	results.push(row);
	console.log(
		'WS_SCALE_RESULT ' +
			Object.entries(row)
				.map(([k, v]) => `${k}=${typeof v === 'number' ? +v.toFixed(2) : v}`)
				.join(' ')
	);
}

async function precreateRecords(host: string, port: number, auth: string) {
	const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
	let next = 0;
	const worker = async () => {
		while (next < topics) {
			const id = next++;
			const body = JSON.stringify({ t: 0, s: 0, p: 'init' });
			await new Promise<void>((resolve, reject) => {
				const req = http.request(
					{
						host,
						port,
						path: `/Bench/${id}`,
						method: 'PUT',
						agent,
						headers: { 'content-type': 'application/json', 'authorization': auth },
					},
					(res) => {
						res.resume();
						res.on('end', () =>
							res.statusCode! < 300 ? resolve() : reject(new Error(`PUT ${id} -> ${res.statusCode}`))
						);
					}
				);
				req.on('error', reject);
				req.end(body);
			});
		}
	};
	await Promise.all(Array.from({ length: 64 }, worker));
	agent.destroy();
}

async function main() {
	ctx = createHarperContext('ws-scale');
	const env: Record<string, string> = { HARPER_STORAGE_ENGINE: args.engine! };
	if (args.uws && !args.uds) env.HARPER_UWS_HTTP = '1';
	const harperConfig: Record<string, unknown> = { threads: { count: threads }, logging: { level: args['log-level'] } };
	if (args.uds) {
		(harperConfig as any).http = { securePort: 9927 };
		(harperConfig as any).tls = { unixDomainSockets: true };
		if (args.uws) env.HARPER_UWS_UDS = '1';
	}
	const usesPreload = args.profile || args.scenario === 'churn';
	const profileDir = args['profile-dir'] ?? (usesPreload ? mkdtempSync(join(tmpdir(), 'ws-scale-')) : '');
	const removeControlDirAfterRun = args.scenario === 'churn' && !args['profile-dir'];
	if (usesPreload) {
		mkdirSync(profileDir, { recursive: true });
		for (const file of readdirSync(profileDir)) {
			if (/^(start|gc-[\d-]+(\.tmp)?|thread-\d+\.(cpuprofile|started)(\.tmp)?)$/.test(file))
				rmSync(join(profileDir, file));
		}
		env.WS_SCALE_CONTROL_DIR = profileDir;
		console.log(`control directory: ${profileDir}`);
		(harperConfig.threads as any).preloadRequire = join(import.meta.dirname, 'harness-preload.cjs');
	}
	let profileStartedAt = Infinity;
	let profileTimer: NodeJS.Timeout | undefined;
	let collections = 0;
	let workerIds: Set<string> | undefined;
	// Every HTTP worker runs a full GC and reports its memory right after it, so retained memory is not confused with
	// uncollected garbage (system_information's per-thread heap comes from a periodic report, so it can be stale).
	// The first collection fixes the set of workers: a restarted worker would replay every request with a fresh
	// heap and make a leak look released, so a change in the set fails the run.
	const ackedIds = (request: string) =>
		readdirSync(profileDir)
			.filter((file) => file.startsWith(`${request}-`) && !file.endsWith('.tmp'))
			.map((file) => file.slice(request.length + 1));
	const collectGarbage = async () => {
		if (!workerIds) {
			workerIds = await liveHttpWorkerIds();
			if (workerIds.size !== threads)
				throw new Error(`expected ${threads} live HTTP workers before GC, found ${workerIds.size}`);
		}
		const request = `gc-${++collections}`;
		writeFileSync(join(profileDir, request), '');
		for (let waited = 0; ; waited += 100) {
			const acked = ackedIds(request);
			const stranger = acked.find((id) => !workerIds!.has(id));
			if (stranger) throw new Error(`thread ${stranger} joined after the first GC; a Harper worker restarted`);
			if (acked.length === workerIds.size) return collectGarbageResult(request, workerIds);
			if (waited > 30_000) throw new Error(`only ${acked.length} Harper workers ran ${request}`);
			await delay(100);
		}
	};
	const collectGarbageResult = async (request: string, ids: Set<string>) => {
		const liveHttpWorkers = await liveHttpWorkerIds();
		if (liveHttpWorkers.size !== ids.size || [...ids].some((id) => !liveHttpWorkers.has(id)))
			throw new Error('HTTP worker set changed while collecting memory');
		const usage = [...ids].map((id) => JSON.parse(readFileSync(join(profileDir, `${request}-${id}`), 'utf8')));
		if (usage.some((thread) => thread.error))
			throw new Error('Harper workers have no gc(); --expose-gc did not reach them');
		const sum = (field: string) => usage.reduce((total, thread) => total + thread[field], 0) / 2 ** 20;
		return { used: sum('heapUsed'), external: sum('external') };
	};
	// renamed into place so a worker polling for it never reads it half-written
	const startProfile = () => {
		if (!args.profile) return;
		writeFileSync(join(profileDir, 'start.tmp'), args.profile);
		renameSync(join(profileDir, 'start.tmp'), join(profileDir, 'start'));
		profileStartedAt = performance.now();
	};
	const profileFinished = () => {
		if (profileStartedAt === Infinity) return false;
		const files = readdirSync(profileDir);
		const started = files.filter((file) => file.endsWith('.started')).length;
		return started >= threads && files.filter((file) => file.endsWith('.cpuprofile')).length >= started;
	};
	// a row whose window overlaps the profile carries the profiler's own CPU and memory
	const profiled = (finishedAtRowStart: boolean, rowEnd: number) =>
		args.profile ? { profiled: !finishedAtRowStart && profileStartedAt < rowEnd } : {};
	for (const pair of args['harper-env']!) {
		const eq = pair.indexOf('=');
		const key = pair.slice(0, eq);
		if (usesPreload && key === 'WS_SCALE_CONTROL_DIR')
			throw new Error(
				'--harper-env cannot override WS_SCALE_CONTROL_DIR; use --profile-dir to choose the control directory'
			);
		env[key] = pair.slice(eq + 1);
	}
	if (args.scenario === 'churn')
		env.NODE_OPTIONS = [env.NODE_OPTIONS ?? process.env.NODE_OPTIONS, '--expose-gc'].filter(Boolean).join(' ');
	try {
		await setupHarperWithFixture(ctx, APP_DIR, {
			harperBinPath: args['harper-bin'],
			config: harperConfig,
			env,
			startupTimeoutMs: 120_000,
		});
	} catch (error) {
		if (removeControlDirAfterRun) rmSync(profileDir, { recursive: true, force: true });
		throw error;
	}
	const clients: Client[] = [];
	const publishers: Client[] = [];
	try {
		const harperPid = ctx.harper.process.pid;
		pin(harperPid, args['harper-cpus']!);
		const { hostname: host, port } = new URL(ctx.harper.httpURL);
		const auth = 'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
		const socketsDir = join(ctx.harper.dataRootDir, 'sockets');
		let udsPaths: string[] | undefined;
		if (args.uds) {
			for (let waited = 0; ; waited += 250) {
				udsPaths = (existsSync(socketsDir) ? readdirSync(socketsDir) : [])
					.filter((file) => /^\d+-.*9927\.sock$/.test(file))
					.map((file) => join(socketsDir, file));
				if (udsPaths.length >= threads) break;
				if (waited > 30_000)
					throw new Error(`only ${udsPaths.length} of ${threads} UDS mirrors bound in ${socketsDir}`);
				await delay(250);
			}
		}
		if (args.uds) console.log(`UDS mirrors: ${udsPaths!.length}`);
		console.log(
			`Harper pid=${harperPid} at ${ctx.harper.httpURL} threads=${threads} cpus=${args['harper-cpus']} uws=${args.uws}`
		);

		for (let i = 0; i < clientCount; i++) clients.push(new Client());
		const clientStats = async () => sumStats(await Promise.all(clients.map((c) => c.request({ cmd: 'stats' }))));
		const clientTicks = () => clients.reduce((sum, c) => sum + cpuTicks(c.child.pid!), 0);

		if (!args.insert) await precreateRecords(host, Number(port), auth);
		await delay(3000);
		const baseRss = rssMB(harperPid);
		const baseHeap = await heapMB();
		console.log(`baseline rss=${baseRss.toFixed(0)}MB heap=${baseHeap.used.toFixed(0)}MB, ${topics} records`);
		let opened = 0;
		const openTo = async (target: number) => {
			const add = target - opened;
			const per = Math.ceil(add / clientCount);
			const connected0 = (await clientStats()).connected;
			const ticks0 = cpuTicks(harperPid);
			const start = performance.now();
			await Promise.all(
				clients.map((client, i) => {
					const count = Math.max(0, Math.min(per, add - i * per));
					return client.request({
						cmd: 'connect',
						host,
						port: Number(port),
						protocol,
						startIndex: opened + i * per,
						count,
						subsPerConn: subs,
						topics,
						sourceIps: sourceIps.filter((_, j) => j % clientCount === i),
						concurrency: Number(args.concurrency),
						auth,
						keepalive: Number(args.keepalive),
						slowFraction: Number(args['slow-fraction']),
						udsPaths,
					});
				})
			);
			const seconds = (performance.now() - start) / 1000;
			const cpuSeconds = (cpuTicks(harperPid) - ticks0) / CLK_TCK;
			opened = target;
			return { seconds, cpuSeconds, added: (await clientStats()).connected - connected0 };
		};

		if (args.scenario === 'conns') {
			// slope between consecutive steps excludes fixed startup cost (JIT, first-connection allocations)
			let prev = { open: 0, rss: baseRss, heap: baseHeap.used };
			const steps = args.steps!.split(',').map(Number);
			for (const step of steps) {
				const profileDone = profileFinished();
				const ramp = await openTo(step);
				if (step === steps.at(-1)) startProfile();
				const ticks0 = cpuTicks(harperPid);
				await delay(Number(args.settle) * 1000);
				const idleCores = (cpuTicks(harperPid) - ticks0) / CLK_TCK / Number(args.settle);
				const settledAt = performance.now();
				const rss = rssMB(harperPid);
				const heap = await heapMB();
				const stats = await clientStats();
				report({
					label: args.label,
					scenario: 'conns',
					protocol,
					uws: args.uws,
					uds: args.uds,
					threads,
					subs,
					topics,
					open: stats.open,
					failed: stats.failed,
					subscribed: stats.subscribed,
					rssMB: rss,
					heapUsedMB: heap.used,
					heapTotalMB: heap.total,
					rssKBPerConn: ((rss - baseRss) * 1024) / stats.open,
					heapKBPerConn: ((heap.used - baseHeap.used) * 1024) / stats.open,
					rssKBPerConnStep: ((rss - prev.rss) * 1024) / (stats.open - prev.open),
					heapKBPerConnStep: ((heap.used - prev.heap) * 1024) / (stats.open - prev.open),
					connectsPerSec: ramp.added / ramp.seconds,
					cpuUsPerConnect: (ramp.cpuSeconds * 1e6) / ramp.added,
					idleCores,
					clientRssMB: stats.rss / 2 ** 20,
					...profiled(profileDone, settledAt),
				});
				prev = { open: stats.open, rss, heap: heap.used };
				if (stats.lastError) console.log(`  last client error: ${stats.lastError}`);
			}
		} else if (args.scenario === 'churn') {
			const conns = Number(args.conns);
			const settleMs = Number(args.settle) * 1000;
			let firstHeld: number | undefined;
			let openedSinceFirst = 0;
			let subscribedBefore = 0;
			let failedBefore = 0;
			let closedBefore = 0;
			let closeCodesBefore: Record<string, number> = {};
			for (let cycle = 1; cycle <= Number(args.cycles); cycle++) {
				await openTo(opened + conns);
				await delay(settleMs);
				const connected = await clientStats();
				const connectedMemory = await collectGarbage();
				const connectedRss = rssMB(harperPid);
				await Promise.all(clients.map((client) => client.request({ cmd: 'disconnect', mode: args.close })));
				await delay(settleMs);
				const memory = await collectGarbage();
				const stats = await clientStats();
				const rss = rssMB(harperPid);
				const closeCodes = Object.fromEntries(
					Object.entries(stats.closeCodes ?? {}).map(([code, count]) => [code, count - (closeCodesBefore[code] ?? 0)])
				);
				const held = memory.used + memory.external;
				if (firstHeld === undefined) firstHeld = held;
				else openedSinceFirst += connected.open;
				report({
					label: args.label,
					scenario: 'churn',
					protocol,
					uws: args.uws,
					uds: args.uds,
					threads,
					close: args.close,
					subs,
					cycle,
					open: connected.open,
					subscribed: connected.subscribed - subscribedBefore,
					failed: stats.failed - failedBefore,
					closed: stats.closed - closedBefore,
					closeCodes: JSON.stringify(closeCodes),
					connectedRssMB: connectedRss,
					connectedHeapMB: connectedMemory.used,
					connectedExternalMB: connectedMemory.external,
					...(connected.open > 0 && {
						releasedKBPerConn: ((connectedMemory.used + connectedMemory.external - held) * 1024) / connected.open,
					}),
					rssMB: rss,
					heapUsedMB: memory.used,
					externalMB: memory.external,
					...(openedSinceFirst > 0 && { retainedBytesPerConn: ((held - firstHeld!) * 2 ** 20) / openedSinceFirst }),
				});
				subscribedBefore = connected.subscribed;
				failedBefore = stats.failed;
				closedBefore = stats.closed;
				closeCodesBefore = stats.closeCodes ?? {};
			}
		} else if (args.scenario === 'fanout') {
			const ramp = await openTo(Number(args.conns));
			// Harper's CPU holding every connection with nothing published, which each row's CPU includes
			const idleTicks0 = cpuTicks(harperPid);
			await delay(Number(args.settle) * 1000);
			const idleCores = (cpuTicks(harperPid) - idleTicks0) / CLK_TCK / Number(args.settle);
			let stats = await clientStats();
			console.log(
				`opened ${stats.open} (failed ${stats.failed}) subscribed ${stats.subscribed} in ${ramp.seconds.toFixed(1)}s; rss=${rssMB(harperPid).toFixed(0)}MB`
			);
			const subscribersPerTopic = stats.subscribed / topics;
			const topicSubscribers: number[] = [];
			for (const reply of await Promise.all(clients.map((client) => client.request({ cmd: 'topics' }))))
				reply.topicSubscribers.forEach(
					(count: number, topic: number) => (topicSubscribers[topic] = (topicSubscribers[topic] ?? 0) + count)
				);
			for (let i = 0; i < Number(args.publishers); i++) publishers.push(new Client());
			const publisherTicks = () => publishers.reduce((sum, p) => sum + cpuTicks(p.child.pid!), 0);
			const publisherStats = async () =>
				sumStats(await Promise.all(publishers.map((p) => p.request({ cmd: 'stats' }))));
			const durationMs = Number(args.duration) * 1000;
			// publisher stats are cumulative across rates
			let publishedTotal = 0;
			let completedTotal = 0;
			let errorsTotal = 0;
			let expectedTotal = 0;
			for (const rate of args.rates!.split(',').map(Number)) {
				const profileDone = profileFinished();
				const before = await clientStats();
				const harper0 = cpuTicks(harperPid);
				const written0 = writeBytes(harperPid);
				const client0 = clientTicks();
				const publisher0 = publisherTicks();
				const start = performance.now();
				if (publishedTotal === 0) profileTimer = setTimeout(startProfile, 5000);
				const published = sumStats(
					await Promise.all(
						publishers.map((publisher, i) =>
							publisher.request({
								cmd: 'publish',
								host,
								port: Number(port),
								mode: args.publish,
								topics,
								topicSubscribers,
								topicOffset: i,
								insert: args.insert,
								rate: rate / publishers.length,
								payloadBytes: Number(args.payload),
								durationMs,
								auth,
							})
						)
					)
				);
				const expected = published.expectedDeliveries - expectedTotal;
				expectedTotal = published.expectedDeliveries;
				// Drain until every expected delivery has arrived and every PUT has settled, nothing progresses for 3 s,
				// or 60 s pass. The row's window and CPU end at the last progress, so a quiet tail is not charged.
				const publishEnd = performance.now();
				let publisherTotals = published;
				let progress = -1;
				let lastProgress = publishEnd;
				let end = { harper: cpuTicks(harperPid), client: clientTicks(), publisher: publisherTicks() };
				let drainEnd: 'complete' | 'quiet' | 'deadline' = 'deadline';
				while (performance.now() - publishEnd < 60_000) {
					stats = await clientStats();
					publisherTotals = await publisherStats();
					const settledPuts = publisherTotals.publishCompleted + publisherTotals.publishErrors;
					if (stats.received + settledPuts > progress) {
						progress = stats.received + settledPuts;
						lastProgress = performance.now();
						end = { harper: cpuTicks(harperPid), client: clientTicks(), publisher: publisherTicks() };
					}
					const putsSettled = args.publish !== 'put' || settledPuts >= publisherTotals.published;
					if (stats.received - before.received >= expected && putsSettled) {
						drainEnd = 'complete';
						break;
					}
					if (performance.now() - lastProgress > 3000) {
						drainEnd = 'quiet';
						break;
					}
					await delay(250);
				}
				const seconds = Math.max(durationMs, lastProgress - start) / 1000;
				const harperCpu = (end.harper - harper0) / CLK_TCK;
				const clientCpu = (end.client - client0) / CLK_TCK;
				const publisherCpu = (end.publisher - publisher0) / CLK_TCK;
				const delivered = stats.received - before.received;
				const publishedCount = published.published - publishedTotal;
				publishedTotal = published.published;
				const completedDelta = publisherTotals.publishCompleted - completedTotal;
				completedTotal = publisherTotals.publishCompleted;
				const putErrors = publisherTotals.publishErrors - errorsTotal;
				errorsTotal = publisherTotals.publishErrors;
				const hist = stats.latencyHist.map((count: number, i: number) => count - (before.latencyHist[i] ?? 0));
				const [p50, p99, p999] = percentiles(hist, [0.5, 0.99, 0.999]);
				report({
					label: args.label,
					scenario: 'fanout',
					protocol,
					uws: args.uws,
					uds: args.uds,
					threads,
					publish: args.publish,
					insert: args.insert,
					conns: stats.open,
					subsPerTopic: subscribersPerTopic,
					slowFraction: Number(args['slow-fraction']),
					payload: Number(args.payload),
					rate,
					publishedPerSec: publishedCount / (durationMs / 1000),
					...(args.publish === 'put' && {
						putsCompletedPerSec: completedDelta / seconds,
						cpuUsPerPut: (harperCpu * 1e6) / completedDelta,
						putErrors,
					}),
					...(expected > 0 && {
						deliveredPerSec: delivered / seconds,
						deliveryRatio: delivered / expected,
						cpuUsPerDelivery: (harperCpu * 1e6) / delivered,
					}),
					harperCores: harperCpu / seconds,
					idleCores,
					clientCores: clientCpu / seconds,
					publisherCores: publisherCpu / seconds,
					drainSeconds: seconds - durationMs / 1000,
					drainEnd,
					latencyMisses: stats.latencyMisses - before.latencyMisses,
					p50ms: p50,
					p99ms: p99,
					p999ms: p999,
					diskBytesPerPublish: (writeBytes(harperPid) - written0) / publishedCount,
					rssMB: rssMB(harperPid),
					disconnected: stats.closed,
					closeCodes: JSON.stringify(stats.closeCodes ?? {}),
					...profiled(profileDone, lastProgress),
				});
			}
		}
		if (profileStartedAt < Infinity) {
			const deadline = profileStartedAt + Number(args.profile) * 1000 + 10_000;
			while (!profileFinished() && performance.now() < deadline) await delay(250);
		}
		if (args.profile && !profileFinished())
			console.warn(
				profileStartedAt < Infinity
					? `not every HTTP worker wrote its profile to ${profileDir}`
					: 'the run ended before profiling began'
			);
	} finally {
		clearTimeout(profileTimer);
		await Promise.all([...clients, ...publishers].map((c) => c.request({ cmd: 'close' }).catch(() => {})));
		try {
			if (args.out) writeFileSync(args.out, JSON.stringify(results, null, 2));
		} finally {
			try {
				await teardownHarper(ctx);
			} finally {
				if (removeControlDirAfterRun) rmSync(profileDir, { recursive: true, force: true });
			}
		}
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
