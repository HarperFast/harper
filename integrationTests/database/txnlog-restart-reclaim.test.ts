/**
 * A RocksDB restart must return purged transaction-log blocks to the filesystem, not merely
 * remove their directory entries. The `statfs` delta is reconciled with every visible allocation
 * change under the isolated data root and must account for at least 75% of the purged blocks.
 *
 * Refs harper#2337.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'txnlog-restart-reclaim');
const AUDIT_RETENTION_SECONDS = 2;
const AUDIT_RETENTION_MS = AUDIT_RETENTION_SECONDS * 1000;
const RETENTION_MARGIN_MS = 500;
const MIN_RECLAIM_BYTES = 64 * 1024 * 1024;
const MIN_RECLAIM_RATIO = 0.75;
const VOLUME_RECORDS = 20_000;
const CHURN_BATCH_RECORDS = 500;
const PAYLOAD = 'p'.repeat(5000);
const RECLAIM_FILESYSTEM_ROOT = '/dev/shm';
const TMPFS_MAGIC = 0x01021994;
const CONFIG = {
	threads: { count: 1 },
	logging: { auditLog: true, auditRetention: AUDIT_RETENTION_SECONDS, level: 'error' as const },
};
const ENV = {
	HARPER_STORAGE_ENGINE: 'rocksdb',
	STORAGE_RECLAMATION_THRESHOLD: 0,
};

type FileAllocation = { path: string; bytes: number; allocatedBytes: number };
type ReclaimState = {
	engineGuess: string;
	oldestSequenceNumber: number;
	currentSequenceNumber: number;
	lastFlushedSequence: number;
	purgeRuns: number;
};

function authHeader(ctx: ContextWithHarper): string {
	const { username, password } = ctx.harper.admin;
	return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

function filesUnder(root: string, matcher: (path: string) => boolean): FileAllocation[] {
	const files: FileAllocation[] = [];
	function walk(directory: string): void {
		let entries: import('node:fs').Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch (error: any) {
			if (error?.code === 'ENOENT') return;
			throw error;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(path);
			} else if (matcher(path)) {
				try {
					const stats = statSync(path);
					files.push({ path, bytes: stats.size, allocatedBytes: stats.blocks * 512 });
				} catch (error: any) {
					if (error?.code !== 'ENOENT') throw error;
				}
			}
		}
	}
	if (existsSync(root)) walk(root);
	return files;
}

function allocatedBytesUnder(root: string): number {
	return filesUnder(root, () => true).reduce((total, file) => total + file.allocatedBytes, 0);
}

function transactionLogsUnder(root: string): FileAllocation[] {
	return filesUnder(root, (path) => path.endsWith('.txnlog'));
}

async function freeBytes(root: string): Promise<number> {
	const stats = await statfs(root);
	return stats.bavail * stats.bsize;
}

async function waitForReclaimState(ctx: ContextWithHarper): Promise<ReclaimState> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		let response: Response;
		try {
			response = await fetch(`${ctx.harper.httpURL}/ReclaimState/`, {
				headers: { Authorization: authHeader(ctx) },
			});
		} catch {
			await sleep(250);
			continue;
		}
		const responseBody = await response.text();
		if (response.status === 404) {
			await sleep(250);
			continue;
		}
		strictEqual(response.status, 200, `ReclaimState failed: ${responseBody.slice(0, 300)}`);
		return JSON.parse(responseBody);
	}
	throw new Error('ReclaimState route did not become ready within 60 seconds');
}

async function createLogVolume(ctx: ContextWithHarper): Promise<void> {
	for (let start = 0; start < VOLUME_RECORDS; start += CHURN_BATCH_RECORDS) {
		const response = await fetch(`${ctx.harper.httpURL}/Churn/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(ctx) },
			body: JSON.stringify({ start, count: Math.min(CHURN_BATCH_RECORDS, VOLUME_RECORDS - start), payload: PAYLOAD }),
			signal: AbortSignal.timeout(120_000),
		});
		const responseBody = await response.text();
		strictEqual(response.status, 200, `transaction-log churn at ${start} failed: ${responseBody.slice(0, 300)}`);
	}
}

async function flush(ctx: ContextWithHarper): Promise<void> {
	const response = await fetch(`${ctx.harper.httpURL}/Flush/`, {
		method: 'POST',
		headers: { Authorization: authHeader(ctx) },
	});
	strictEqual(response.status, 200, `Flush failed: ${(await response.text()).slice(0, 300)}`);
}

async function flushUntilPurgeable(ctx: ContextWithHarper): Promise<ReclaimState> {
	const deadline = Date.now() + 30_000;
	let state: ReclaimState;
	do {
		await flush(ctx);
		state = await waitForReclaimState(ctx);
		if (
			state.oldestSequenceNumber < state.currentSequenceNumber &&
			state.lastFlushedSequence > state.oldestSequenceNumber
		)
			return state;
		await sleep(250);
	} while (Date.now() < deadline);
	throw new Error(
		`transaction log did not become purgeable: oldest=${state.oldestSequenceNumber}, ` +
			`current=${state.currentSequenceNumber}, lastFlushed=${state.lastFlushedSequence}`
	);
}

suite(
	'RocksDB restart returns purged transaction-log blocks to the filesystem (#2337)',
	{
		skip: process.platform !== 'linux' || process.env.HARPER_RUNTIME === 'bun' || !existsSync(RECLAIM_FILESYSTEM_ROOT),
	},
	(ctx: ContextWithHarper) => {
		before(async () => {
			const previousInstallParent = process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR;
			process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR = RECLAIM_FILESYSTEM_ROOT;
			try {
				await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: CONFIG, env: ENV });
			} finally {
				if (previousInstallParent === undefined) delete process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR;
				else process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR = previousInstallParent;
			}
			strictEqual((await statfs(ctx.harper.dataRootDir)).type, TMPFS_MAGIC, 'reclaim test requires a tmpfs data root');
			const initialState = await waitForReclaimState(ctx);
			strictEqual(initialState.engineGuess, 'rocksdb');
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('startup purge reclaims visible and filesystem-allocated bytes together', { timeout: 180_000 }, async () => {
			await createLogVolume(ctx);
			await flushUntilPurgeable(ctx);
			const liveLogs = transactionLogsUnder(ctx.harper.dataRootDir);
			ok(liveLogs.length > 1, `expected transaction-log rotation, found ${liveLogs.length} file(s)`);
			ok(
				liveLogs.reduce((total, file) => total + file.bytes, 0) > MIN_RECLAIM_BYTES,
				`expected more than ${MIN_RECLAIM_BYTES} transaction-log bytes before restart`
			);
			await killHarper(ctx);
			const stoppedLogs = transactionLogsUnder(ctx.harper.dataRootDir);
			const stoppedPaths = new Set(stoppedLogs.map((file) => file.path));
			ok(
				liveLogs.every((file) => stoppedPaths.has(file.path)),
				'a transaction log disappeared during shutdown instead of the startup purge under test'
			);
			await sleep(AUDIT_RETENTION_MS + RETENTION_MARGIN_MS);

			const preBootLogs = transactionLogsUnder(ctx.harper.dataRootDir);
			const preBootPaths = new Set(preBootLogs.map((file) => file.path));
			ok(
				stoppedLogs.every((file) => preBootPaths.has(file.path)),
				'a transaction log disappeared while Harper was stopped'
			);
			const preBootAllocated = allocatedBytesUnder(ctx.harper.dataRootDir);
			const preBootFree = await freeBytes(ctx.harper.dataRootDir);

			await startHarper(ctx, { config: CONFIG, env: ENV });
			const restartState = await waitForReclaimState(ctx);
			strictEqual(restartState.purgeRuns, 1, 'expected the restart purge to be the only cleanup pass');

			const postBootLogs = transactionLogsUnder(ctx.harper.dataRootDir);
			const postBootPaths = new Set(postBootLogs.map((file) => file.path));
			const removedLogs = preBootLogs.filter((file) => !postBootPaths.has(file.path));
			const removedAllocated = removedLogs.reduce((total, file) => total + file.allocatedBytes, 0);
			ok(
				removedAllocated >= MIN_RECLAIM_BYTES,
				`startup purge removed only ${removedAllocated} allocated transaction-log bytes; expected at least ${MIN_RECLAIM_BYTES}`
			);

			const postBootAllocated = allocatedBytesUnder(ctx.harper.dataRootDir);
			const dataRootAllocatedDelta = postBootAllocated - preBootAllocated;
			const filesystemFreeDelta = (await freeBytes(ctx.harper.dataRootDir)) - preBootFree;
			const filesystemReclaim = filesystemFreeDelta + dataRootAllocatedDelta + removedAllocated;
			console.log(
				`restart reclaim: removed txnlogs=${removedAllocated} bytes, data-root allocated delta=${dataRootAllocatedDelta} bytes, ` +
					`filesystem free delta=${filesystemFreeDelta} bytes, reconciled txnlog reclaim=${filesystemReclaim} bytes`
			);
			ok(
				filesystemReclaim >= removedAllocated * MIN_RECLAIM_RATIO,
				`startup removed ${removedAllocated} allocated transaction-log bytes, but statfs reported a free-space delta of ` +
					`${filesystemFreeDelta} bytes after accounting for a ${dataRootAllocatedDelta}-byte change under the data root; ` +
					`only ${filesystemReclaim} bytes (${((filesystemReclaim / removedAllocated) * 100).toFixed(1)}%) were actually reclaimed`
			);
		});
	}
);
