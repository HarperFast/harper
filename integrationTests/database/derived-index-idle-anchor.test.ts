/**
 * A native HNSW index whose transaction log goes idle and is emptied by audit retention resumes without
 * a rebuild after a restart (harper#3631). The runner hand-off case is in derivedIndexRuntimeRocks.test.js:
 * here every retention pass commits and wakes the runner, so it never reaches its idle release.
 *
 * rocksdb-js 2.12 retention deletes every fully flushed file of a log, including the one holding the
 * last transaction the index's durable cursor anchors. The cursor's persisted coverage and the log's
 * flush witness prove nothing after that anchor was lost, so the next install reads the log from a floor
 * instead of condemning the cursor.
 *
 * "No rebuild" is read from the worker's `needs rebuild` error lines across every boot's hdb.log, anchored
 * by the first boot's own line for the fresh index (`backend has no durable cursor`). The restart is
 * graceful, so it does not prove recovery from a crash.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	setupHarperWithFixture,
	teardownHarper,
	killHarper,
	startHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import { waitFor } from '../../unitTests/waitFor.js';

const FIXTURE_PATH = resolve(import.meta.dirname, 'derived-index-idle-anchor');
// The native HNSW plane is not built for Bun; Windows is skipped on harper#2401 (a purge takes the process
// down there); uWS HTTP aborts on shutdown (harper#3176), and this suite restarts.
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32' || !!process.env.HARPER_UWS_HTTP;

const OPTIONS = {
	config: {
		threads: { count: 1 },
		logging: { level: 'warn', auditRetention: '2s' },
		storage: { engine: 'rocksdb' },
	},
	env: { HARPER_STORAGE_ENGINE: 'rocksdb' },
	harperBinPath: resolve('dist/bin/harper.js'),
};

const vectorOf = (id: number) => Array.from({ length: 8 }, (_, i) => Math.sin(id * 7 + i * 3 + 1));

suite('a derived index over an idle log that retention emptied', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	const logDirs = new Set<string>();
	const noteLogDir = () => {
		logDirs.add(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'));
		logDirs.add(join(ctx.harper.dataRootDir, 'log'));
	};
	const headers = () => ({
		'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
		'Content-Type': 'application/json',
	});
	async function request(path: string, method = 'GET', body?: unknown) {
		const response = await fetch(`${ctx.harper.httpURL}${path}`, {
			method,
			headers: headers(),
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		return { status: response.status, body: text ? JSON.parse(text) : undefined };
	}
	const status = async () => (await request('/IdleStatus/')).body;
	const nearest = async (id: number) => {
		const result = await request('/IdleProbe/', 'QUERY', {
			sort: { attribute: 'vector', target: vectorOf(id), distance: 'cosine' },
			select: ['id'],
			limit: 1,
		});
		return result.status === 200 ? result.body[0]?.id : undefined;
	};
	const put = async (id: number) => {
		const result = await request(`/IdleProbe/${id}`, 'PUT', { id, vector: vectorOf(id) });
		ok(result.status < 300, JSON.stringify(result));
	};
	const caughtUp = () =>
		waitFor(
			async () => {
				const { cursor, log, readiness } = await status();
				return (
					readiness.state === 'ready' &&
					cursor?.logs?.local !== undefined &&
					cursor.coverage?.local?.sequence === log.lastCommittedPosition.sequence &&
					cursor.coverage?.local?.offset === log.lastCommittedPosition.offset
				);
			},
			{ timeout: 60_000, message: 'the index never caught up with a persisted coverage' }
		);
	const emptiedByRetention = () =>
		waitFor(
			async () => {
				await request('/IdleFlush/', 'POST');
				return (await status()).log.fileCount === 0;
			},
			{ timeout: 60_000, message: 'retention never emptied the transaction log' }
		);
	const rebuildLines = () => {
		let lines: string[] = [];
		for (const dir of logDirs) {
			const file = join(dir, 'hdb.log');
			if (existsSync(file)) lines = lines.concat(readFileSync(file, 'utf8').split('\n'));
		}
		return lines.filter((line) => line.includes("Derived index '") && line.includes('needs rebuild'));
	};

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, OPTIONS);
		noteLogDir();
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('resumes after a restart without a rebuild', { timeout: 300_000 }, async () => {
		await waitFor(async () => (await status()).readiness.state === 'ready', { timeout: 60_000 });
		for (let id = 0; id < 20; id++) await put(id);
		await waitFor(async () => (await nearest(19)) === 19, { timeout: 60_000 });
		await caughtUp();
		const indexed = await status();
		await emptiedByRetention();
		deepStrictEqual(
			(await status()).log.lastFlushedPosition,
			indexed.cursor.coverage.local,
			'the flush witness is the covered tail'
		);
		strictEqual((await status()).cursor.logs.local, indexed.cursor.logs.local, 'the anchor did not move');

		const linesBefore = rebuildLines();
		ok(
			linesBefore.some((line) => line.includes('backend has no durable cursor')),
			`the fresh index's own rebuild line is the anchor: ${JSON.stringify(linesBefore)}`
		);
		await killHarper(ctx);
		await startHarper(ctx, OPTIONS);
		noteLogDir();
		await waitFor(async () => (await status()).readiness.state === 'ready', { timeout: 60_000 });
		strictEqual(await nearest(3), 3, 'a record indexed before the purge is still found');
		await put(100);
		await waitFor(async () => (await nearest(100)) === 100, { timeout: 60_000 });

		await waitFor(
			async () => {
				const { cursor } = await status();
				return cursor.logs.local !== undefined && cursor.floors === undefined;
			},
			{ timeout: 60_000, message: 'the next commit did not anchor the log again' }
		);

		deepStrictEqual(rebuildLines().slice(linesBefore.length), [], 'the install after the restart condemned nothing');
	});
});
