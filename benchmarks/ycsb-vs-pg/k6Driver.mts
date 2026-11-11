/**
 * The load generator: k6 (https://grafana.com/docs/k6/) runs every phase of a sample (the load, the
 * read-all pass, warmup chunks and measured runs) with the keys, op mix, records and links of
 * ../ycsb/workload.mts, in the same closed loop as before: `concurrency` VUs, one request in flight each.
 *
 * Each phase is one `k6 run` of k6Workload.mjs (shared-iterations, so every key or op is run exactly
 * once). Its `setup()` and `teardown()` block on this process's control server, which is where a
 * measured window opens and closes: k6's startup, VU initialization and summary stay outside it. The
 * phase's parameters reach k6 in its environment and its results come back on stdout, so no file is
 * shared with k6 (a snap-packaged k6 has a private /tmp and no access to hidden directories).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WORKLOADS } from '../ycsb/workload.mts';
import type { DistributionName, LatencyStats, OperationType, PhaseResult, RecordShape } from '../ycsb/workload.mts';
import { cpuSecondsOf, verifyAffinity } from './resources.mts';

const SCRIPT_PATH = join(import.meta.dirname, 'k6Workload.mjs');
const WORKLOAD_PATH = join(import.meta.dirname, '..', 'ycsb', 'workload.mts');
const WORKLOAD_IMPORT = /^import \{[^}]*\} from '\.\.\/ycsb\/workload\.mts';\n/m;
const SUMMARY_MARKER = 'YCSB_K6_SUMMARY ';
/** k6's built-in HTTP trends keep every sample: a load or read-all pass runs this many keys per process. */
const RANGE_CHUNK = 2_000_000;
/** The phase's ceiling inside k6. Every request has its own timeout, so a phase cannot stall past it. */
const MAX_PHASE = '24h';
const MAX_PHASE_MS = 24 * 3_600_000;
const CONTROL_TIMEOUT = '3600s';
const REQUEST_TIMEOUT = '30s';

export interface DriverConfig {
	baseUrl: string;
	table: string;
	records: number;
	opsPerWorkload: number;
	concurrency: number;
	shape: RecordShape;
	keyWidth: number;
	maxScanLength: number;
	/** false attaches to an already-loaded dataset (a restored snapshot) instead of inserting it. */
	load?: boolean;
	authorization?: string;
	callerAuthorizations?: Record<string, string>;
	/** The generator's CPUs: every k6 thread must run on them (checked as each phase starts). */
	cpus?: number[];
}

/** Opens and closes a measured window around a phase's iterations. */
export interface PhaseWindow {
	begin(): Promise<void>;
	end(): Promise<void>;
}

export interface GeneratorResult extends PhaseResult {
	/** k6's CPU over the phase's iterations. */
	generatorCpuSeconds: number;
}

export interface DriverRun {
	load: GeneratorResult;
	/** Reads every loaded key exactly once. */
	readAll(): Promise<GeneratorResult>;
	runWorkload(
		name: string,
		distribution?: DistributionName,
		opsOverride?: number,
		mix?: Record<string, number>,
		window?: PhaseWindow
	): Promise<GeneratorResult>;
	close(): Promise<void>;
}

/** What one k6 run does; k6Workload.mjs reads it from YCSB_PHASE. */
export interface K6Phase {
	phase: 'load' | 'readAll' | 'run';
	baseUrl: string;
	table: string;
	vus: number;
	iterations: number;
	records: number;
	keyWidth: number;
	shape: RecordShape;
	maxScanLength: number;
	/** load / readAll: the first key index; iteration i handles key from + i. */
	from?: number;
	workload?: string;
	distribution?: DistributionName;
	mix?: Record<string, number>;
	authorization?: string;
	callerAuthorizations?: Record<string, string>;
}

export const k6Binary = (): string => process.env.YCSB_K6 || 'k6';

export const K6_LATENCY_BASIS = "the op's requests' send, wait and receive time (k6 timings.duration, summed)";
export const NODE_LATENCY_BASIS = 'wall time around the op in the generator process (performance.now)';

/** `k6 v2.3.0 (...)`, for the results' meta. */
export function k6Version(): string {
	return execFileSync(k6Binary(), ['version'], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n')[0];
}

let script: string | undefined;

/** workload.mts without its types, then k6Workload.mjs without its import of it: one module for k6. */
function k6Script(): string {
	if (script) return script;
	const body = readFileSync(SCRIPT_PATH, 'utf8');
	if (!WORKLOAD_IMPORT.test(body)) throw new Error(`${SCRIPT_PATH} no longer imports ../ycsb/workload.mts`);
	const workload = stripTypeScriptTypes(readFileSync(WORKLOAD_PATH, 'utf8'), { mode: 'strip' });
	script = `${workload}\n${body.replace(WORKLOAD_IMPORT, '')}`;
	return script;
}

interface K6Summary {
	phaseId: string;
	iterations: number;
	ops: number;
	errors: number;
	latency: Partial<Record<OperationType, LatencyStats>>;
}

/** The phase's summary line from k6's stdout; fails unless it is this phase's and every iteration ran. */
export function parseSummary(stdout: string, phaseId: string, iterations: number): K6Summary {
	const line = stdout
		.split('\n')
		.reverse()
		.find((l) => l.startsWith(SUMMARY_MARKER));
	if (!line) throw new Error('k6 printed no summary');
	const summary = JSON.parse(line.slice(SUMMARY_MARKER.length)) as K6Summary;
	if (summary.phaseId !== phaseId) throw new Error(`k6 summary is for phase ${summary.phaseId}, not ${phaseId}`);
	if (summary.iterations !== iterations || summary.ops + summary.errors !== iterations) {
		throw new Error(
			`k6 ran ${summary.iterations} of ${iterations} iterations (${summary.ops} ops, ${summary.errors} errors)`
		);
	}
	for (const [type, stats] of Object.entries(summary.latency)) {
		if (!Object.values(stats).every(Number.isFinite)) throw new Error(`k6 latency for ${type} is not finite`);
	}
	return summary;
}

type PhaseState = 'starting' | 'beginning' | 'running' | 'ending' | 'ended' | 'failed';

const EMPTY: GeneratorResult = { ops: 0, errors: 0, elapsedMs: 0, throughput: 0, latency: {}, generatorCpuSeconds: 0 };

/**
 * Runs one k6 phase. This process owns the window: it opens it once (when k6's setup asks), closes
 * it once (when teardown asks, or when k6 exits without asking), and reports the first failure.
 */
async function runPhase(
	phase: K6Phase,
	{ cpus, window }: { cpus?: number[]; window?: PhaseWindow } = {}
): Promise<GeneratorResult> {
	const token = randomBytes(16).toString('hex');
	const phaseId = randomBytes(8).toString('hex');
	// Widened: the server's handler and fail() change it.
	let state = 'starting' as PhaseState;
	let failure: unknown;
	let child: ChildProcess | undefined;
	let windowOpen = false;
	let closing: Promise<void> | undefined;
	/** The control requests being handled; k6's exit waits for them, so a window opening as k6 dies still closes. */
	const handling = new Set<Promise<void>>();
	let startedAt = 0;
	let elapsedMs = 0;
	let cpuAtStart = 0;
	let cpuAtEnd = 0;
	const fail = (error: unknown) => {
		failure ??= error;
		state = 'failed';
	};
	const closeWindow = (): Promise<void> => {
		if (windowOpen) {
			windowOpen = false;
			closing = window!.end().catch(fail);
		}
		return closing ?? Promise.resolve();
	};
	const settle = async () => {
		await Promise.allSettled([...handling]);
		await closeWindow();
	};

	async function ready(): Promise<void> {
		const pid = child!.pid!;
		if (cpus) verifyAffinity('generator', pid, cpus);
		cpuAtStart = await cpuSecondsOf([pid]);
		if (window) {
			await window.begin();
			windowOpen = true;
		}
		startedAt = performance.now();
	}

	async function done(): Promise<void> {
		elapsedMs = performance.now() - startedAt;
		cpuAtEnd = await cpuSecondsOf([child!.pid!]);
	}

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const step = request.url === `/${token}/ready` ? 'ready' : request.url === `/${token}/done` ? 'done' : undefined;
		const expected = step === 'ready' ? 'starting' : 'running';
		if (!step || state !== expected) {
			response.writeHead(step ? 409 : 404).end(step ? `${step} while ${state}` : 'not found');
			return;
		}
		state = step === 'ready' ? 'beginning' : 'ending';
		try {
			await (step === 'ready' ? ready() : done());
			if (step === 'done') await closeWindow();
		} catch (error) {
			fail(error);
		}
		if (failure !== undefined) {
			response.writeHead(500).end((failure as Error)?.message ?? 'failed');
			return;
		}
		state = step === 'ready' ? 'running' : 'ended';
		response.writeHead(200).end(step);
	}

	const server = createServer((request, response) => {
		const work = handle(request, response).catch((error) => {
			fail(error);
			if (!response.headersSent) response.writeHead(500).end();
		});
		handling.add(work);
		void work.finally(() => handling.delete(work));
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const { port } = server.address() as AddressInfo;
	let stdout = '';
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		child = spawn(k6Binary(), ['run', '--quiet', '--no-usage-report', '--address=', '--no-color', '-'], {
			stdio: ['pipe', 'pipe', 'inherit'],
			env: {
				...process.env,
				K6_NO_USAGE_REPORT: 'true',
				YCSB_PHASE: JSON.stringify({
					...phase,
					phaseId,
					control: `http://127.0.0.1:${port}/${token}`,
					maxDuration: MAX_PHASE,
					controlTimeout: CONTROL_TIMEOUT,
					requestTimeout: REQUEST_TIMEOUT,
				}),
			},
		});
		child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
		child.stdin!.on('error', fail).end(k6Script());
		const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			child!.once('error', reject);
			child!.once('exit', (code, signal) => resolve({ code, signal }));
			deadline = setTimeout(() => {
				fail(new Error(`k6 ${phase.phase} phase ran past ${MAX_PHASE}`));
				child!.kill('SIGKILL');
			}, MAX_PHASE_MS + 3_600_000);
		});
		// k6 died, or was aborted, with the window open: close it here, since teardown never asked.
		await settle();
		if (failure) throw failure;
		if (exited.code !== 0) throw new Error(`k6 exited ${exited.code ?? exited.signal} in the ${phase.phase} phase`);
		if (state !== 'ended') throw new Error(`k6 exited without finishing the ${phase.phase} phase (${state})`);
		const summary = parseSummary(stdout, phaseId, phase.iterations);
		return {
			ops: summary.ops,
			errors: summary.errors,
			elapsedMs,
			throughput: summary.ops === 0 ? 0 : (summary.ops * 1000) / elapsedMs,
			latency: summary.latency,
			generatorCpuSeconds: cpuAtEnd - cpuAtStart,
		};
	} finally {
		clearTimeout(deadline);
		if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
		await settle();
		server.closeAllConnections();
		server.close();
	}
}

function sumRanges(parts: GeneratorResult[]): GeneratorResult {
	const ops = parts.reduce((sum, p) => sum + p.ops, 0);
	const elapsedMs = parts.reduce((sum, p) => sum + p.elapsedMs, 0);
	return {
		ops,
		errors: parts.reduce((sum, p) => sum + p.errors, 0),
		elapsedMs,
		throughput: ops === 0 ? 0 : (ops * 1000) / elapsedMs,
		latency: {},
		generatorCpuSeconds: parts.reduce((sum, p) => sum + p.generatorCpuSeconds, 0),
	};
}

export async function startDriver(config: DriverConfig): Promise<DriverRun> {
	if (!(config.concurrency >= 1)) throw new Error(`concurrency must be at least 1, got ${config.concurrency}`);
	const base = {
		baseUrl: config.baseUrl,
		table: config.table,
		records: config.records,
		keyWidth: config.keyWidth,
		shape: config.shape,
		maxScanLength: config.maxScanLength,
		authorization: config.authorization,
	};
	// k6 refuses a shared-iterations scenario with more VUs than iterations.
	const vus = (iterations: number) => Math.min(config.concurrency, iterations);
	const range = async (phase: 'load' | 'readAll'): Promise<GeneratorResult> => {
		const parts: GeneratorResult[] = [];
		for (let from = 0; from < config.records; from += RANGE_CHUNK) {
			const iterations = Math.min(RANGE_CHUNK, config.records - from);
			parts.push(await runPhase({ ...base, phase, from, iterations, vus: vus(iterations) }, { cpus: config.cpus }));
		}
		return sumRanges(parts);
	};
	const load = config.load === false ? { ...EMPTY } : await range('load');
	return {
		load,
		readAll: () => range('readAll'),
		async runWorkload(name, distribution, opsOverride, mix, window) {
			if (!WORKLOADS[name]) throw new Error(`unknown workload ${name}`);
			const iterations = opsOverride ?? config.opsPerWorkload;
			if (iterations === 0) return { ...EMPTY };
			return runPhase(
				{
					...base,
					phase: 'run',
					iterations,
					vus: vus(iterations),
					workload: name,
					distribution,
					mix,
					callerAuthorizations: config.callerAuthorizations,
				},
				{ cpus: config.cpus, window }
			);
		},
		close: async () => {},
	};
}
