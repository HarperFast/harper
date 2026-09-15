/**
 * Multi-process load driver.
 *
 * The single-process YCSB runner in benchmarks/ycsb saturates one core at
 * roughly 38k req/s on this host (see client-ceiling.mts), which is below what
 * the targets can serve — so a single-process measurement reports the client's
 * limit, not the server's. This driver forks `shards` copies of the workload and
 * sums them, moving the client ceiling out of the way.
 *
 * Sharding is exact for insert-free workloads (A, B, C, F): every shard draws
 * independently from the same loaded keyspace, which is statistically identical
 * to one process drawing at N× the rate. Workloads that insert (D, E) would need
 * the shards to coordinate key allocation, so they fall back to a single shard.
 */
import { fork } from 'node:child_process';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { WORKLOADS } from '../ycsb/workload.mts';
import type { LatencyStats, OperationType, PhaseResult, RecordShape } from '../ycsb/workload.mts';
import type { ShardCommand } from './shardWorker.mts';

const WORKER_PATH = join(import.meta.dirname, 'shardWorker.mts');

export interface DriverConfig {
	baseUrl: string;
	table: string;
	records: number;
	opsPerWorkload: number;
	concurrency: number;
	shards: number;
	shape: RecordShape;
	keyWidth: number;
	maxScanLength: number;
}

class ShardPool {
	private children: ChildProcess[] = [];

	async start(count: number): Promise<void> {
		this.children = await Promise.all(
			Array.from({ length: count }, () => {
				const child = fork(WORKER_PATH, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
				return new Promise<ChildProcess>((resolve) => child.once('message', () => resolve(child)));
			})
		);
	}

	/** Runs one command per shard in parallel and returns each shard's result. */
	async dispatch(commands: ShardCommand[]): Promise<PhaseResult[]> {
		return Promise.all(
			commands.map(
				(command, i) =>
					new Promise<PhaseResult>((resolve, reject) => {
						const child = this.children[i];
						child.once('message', (reply: { ok: boolean; result?: PhaseResult; error?: string }) => {
							if (reply.ok) resolve(reply.result!);
							else reject(new Error(`shard ${i}: ${reply.error}`));
						});
						child.send(command);
					})
			)
		);
	}

	get size(): number {
		return this.children.length;
	}

	stop(): void {
		for (const child of this.children) child.kill();
		this.children = [];
	}
}

/**
 * Combines shard results into one. Throughput is total ops over the slowest
 * shard's wall clock (the conservative reading — the fast shards were idle at
 * the end). Latency percentiles are count-weighted means of the shards' own
 * percentiles: an approximation, since true percentiles can't be merged from
 * summaries, but the shards are running identical work so their distributions
 * are near-identical and the error is small.
 */
export function mergeShardResults(results: PhaseResult[]): PhaseResult {
	const ops = results.reduce((sum, r) => sum + r.ops, 0);
	const errors = results.reduce((sum, r) => sum + r.errors, 0);
	const elapsedMs = Math.max(...results.map((r) => r.elapsedMs));
	const latency: Partial<Record<OperationType, LatencyStats>> = {};
	const types = new Set<OperationType>(results.flatMap((r) => Object.keys(r.latency) as OperationType[]));
	for (const type of types) {
		const parts = results.map((r) => r.latency[type]).filter((s): s is LatencyStats => s !== undefined);
		const count = parts.reduce((sum, s) => sum + s.count, 0);
		if (count === 0) continue;
		const weighted = (pick: (s: LatencyStats) => number) =>
			parts.reduce((sum, s) => sum + pick(s) * s.count, 0) / count;
		latency[type] = {
			count,
			min: Math.min(...parts.map((s) => s.min)),
			max: Math.max(...parts.map((s) => s.max)),
			mean: weighted((s) => s.mean),
			p50: weighted((s) => s.p50),
			p95: weighted((s) => s.p95),
			p99: weighted((s) => s.p99),
			p999: weighted((s) => s.p999),
		};
	}
	return { ops, errors, elapsedMs, throughput: ops === 0 ? 0 : (ops * 1000) / elapsedMs, latency };
}

/** Splits `total` into `parts` near-equal integers that sum back to `total`. */
function split(total: number, parts: number): number[] {
	const base = Math.floor(total / parts);
	return Array.from({ length: parts }, (_, i) => base + (i < total % parts ? 1 : 0));
}

export interface DriverRun {
	load: PhaseResult;
	runWorkload(name: string, distribution?: 'uniform' | 'zipfian' | 'latest', opsOverride?: number): Promise<PhaseResult>;
	shardsUsed(name: string): number;
	close(): void;
}

export async function startDriver(config: DriverConfig): Promise<DriverRun> {
	const pool = new ShardPool();
	await pool.start(config.shards);

	const base = {
		baseUrl: config.baseUrl,
		table: config.table,
		shape: config.shape,
		keyWidth: config.keyWidth,
		maxScanLength: config.maxScanLength,
	};

	const loadSizes = split(config.records, config.shards);
	let cursor = 0;
	const loadCommands: ShardCommand[] = loadSizes.map((size, i) => {
		const from = cursor;
		cursor += size;
		return {
			...base,
			phase: 'load',
			concurrency: split(config.concurrency, config.shards)[i],
			from,
			to: cursor,
		};
	});
	const load = mergeShardResults(await pool.dispatch(loadCommands));

	// Inserting workloads can't be split without cross-shard key coordination.
	const shardsFor = (name: string) => (WORKLOADS[name].mix.insert ? 1 : config.shards);

	return {
		load,
		shardsUsed: shardsFor,
		async runWorkload(name, distribution, opsOverride) {
			const shards = shardsFor(name);
			const ops = split(opsOverride ?? config.opsPerWorkload, shards);
			const conc = split(config.concurrency, shards);
			const commands: ShardCommand[] = ops.map((opCount, i) => ({
				...base,
				phase: 'run',
				concurrency: conc[i],
				workload: name,
				opCount,
				records: config.records,
				distribution,
			}));
			return mergeShardResults(await pool.dispatch(commands));
		},
		close(): void {
			pool.stop();
		},
	};
}
