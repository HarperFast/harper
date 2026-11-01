/**
 * One shard of the load generator. Forked by shardedDriver.mts; a single Node
 * process tops out around 38k req/s on this client path, well under what either
 * target can serve, so load is spread over several of these.
 *
 * Each shard owns its own REST client, its own KeyState (independent draws from
 * the same loaded keyspace) and its own slice of the op count.
 */
import { createRestExecutor } from '../ycsb/restClient.mts';
import { KeyState, buildRecord, formatKey, runOperations, WORKLOADS } from '../ycsb/workload.mts';
import type { PhaseResult, RecordShape } from '../ycsb/workload.mts';

export interface ShardCommand {
	phase: 'load' | 'readAll' | 'run';
	baseUrl: string;
	table: string;
	concurrency: number;
	shape: RecordShape;
	keyWidth: number;
	maxScanLength: number;
	/** Sent on every request when the target checks a credential (--auth=token). */
	authorization?: string;
	/** --auth=token: each record owner's credential, which inspect requests carry instead. */
	callerAuthorizations?: Record<string, string>;
	/** load / readAll: the [from, to) key range this shard inserts or reads. */
	from?: number;
	to?: number;
	/** The loaded keyspace size (every record's link stays within it); run: also the readable keyspace. */
	records: number;
	/** run: workload name and op count for this shard. */
	workload?: string;
	/** Overrides the named workload's mix, for write-ratio sweeps. */
	mix?: Record<string, number>;
	opCount?: number;
	distribution?: 'uniform' | 'zipfian' | 'latest';
}

/** Inserts (load) or reads (readAll) every key in [from, to) exactly once. */
async function rangePhase(command: ShardCommand): Promise<PhaseResult> {
	const executor = createRestExecutor({
		baseUrls: [command.baseUrl],
		table: command.table,
		maxSockets: command.concurrency,
		authorization: command.authorization,
	});
	const from = command.from!;
	const to = command.to!;
	let next = from;
	let errors = 0;
	const start = performance.now();
	const worker = async (): Promise<void> => {
		while (true) {
			const index = next++;
			if (index >= to) break;
			try {
				const key = formatKey(index, command.keyWidth);
				if (command.phase === 'load') {
					const link = { index, keyCount: command.records, keyWidth: command.keyWidth };
					await executor.insert(key, buildRecord(command.shape, link));
				} else {
					await executor.read(key);
				}
			} catch {
				errors++;
			}
		}
	};
	await Promise.all(Array.from({ length: command.concurrency }, worker));
	const elapsedMs = performance.now() - start;
	executor.close();
	const ops = to - from - errors;
	return { ops, errors, elapsedMs, throughput: (ops * 1000) / elapsedMs, latency: {} };
}

async function runPhase(command: ShardCommand): Promise<PhaseResult> {
	const executor = createRestExecutor({
		baseUrls: [command.baseUrl],
		table: command.table,
		maxSockets: command.concurrency,
		authorization: command.authorization,
		callerAuthorizations: command.callerAuthorizations,
	});
	const spec = WORKLOADS[command.workload!];
	const keys = new KeyState({
		distribution: command.distribution ?? spec.distribution,
		initialKeyCount: command.records,
		keyWidth: command.keyWidth,
		shape: command.shape,
		maxScanLength: command.maxScanLength,
	});
	const result = await runOperations({
		opCount: command.opCount!,
		concurrency: command.concurrency,
		mix: (command.mix as typeof spec.mix) ?? spec.mix,
		chainHops: spec.chainHops,
		executor,
		keys,
	});
	executor.close();
	return result;
}

process.on('message', async (command: ShardCommand) => {
	try {
		const result = command.phase === 'run' ? await runPhase(command) : await rangePhase(command);
		process.send!({ ok: true, result });
	} catch (error) {
		process.send!({ ok: false, error: (error as Error).message });
	}
});
process.send!('ready');
