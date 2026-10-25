/**
 * A Harper server enables Node's compile cache in <rootPath>/cache/compile (on an existing install, before its main
 * thread loads bin/run.js), every worker it starts (restart replacements included) uses the same directory, a restart reuses the
 * entries instead of rewriting them, pruning removes only other Node versions, and NODE_DISABLE_COMPILE_CACHE turns
 * all of it off.
 */
import { after, before, suite, test } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	killHarper,
	sendOperation,
	setupHarperWithFixture,
	startHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/compile-cache-probe');
const MAIN_HOOK = resolve(import.meta.dirname, 'fixtures/compile-cache-main-hook.cjs').replaceAll('\\', '/');
const STALE = 'v1.2.3-x64-0123abcd-1000';

// Bun has no module.enableCompileCache, so Harper leaves the cache off there.
suite('Node compile cache', { skip: process.env.HARPER_RUNTIME === 'bun' }, (ctx: ContextWithHarper) => {
	const scratch = mkdtempSync(join(tmpdir(), 'harper-compile-cache-'));
	const probeOut = join(scratch, 'main-thread.json');
	const harperEnv = (extra: Record<string, string | undefined> = {}) => ({
		NODE_COMPILE_CACHE: undefined,
		NODE_DISABLE_COMPILE_CACHE: undefined,
		NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(MAIN_HOOK)}`.trim(),
		COMPILE_CACHE_PROBE_OUT: probeOut,
		...extra,
	});
	let cacheBase: string;

	async function probe(): Promise<{ threadId: number; cacheDirectory: string | null }> {
		const response = await fetch(`${ctx.harper.httpURL}/CompileCacheProbe`);
		strictEqual(response.status, 200, await response.clone().text());
		return response.json();
	}

	function mainThreadCacheDirectory(): string | null {
		return JSON.parse(readFileSync(probeOut, 'utf8')).cacheDirectory;
	}

	function cacheEntries(): Map<string, number> {
		const entries = new Map<string, number>();
		for (const subdirectory of readdirSync(cacheBase)) {
			if (!subdirectory.startsWith(`${process.version}-`)) continue;
			for (const entry of readdirSync(join(cacheBase, subdirectory))) {
				const path = join(cacheBase, subdirectory, entry);
				entries.set(path, statSync(path).mtimeMs);
			}
		}
		return entries;
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { env: harperEnv() });
		cacheBase = join(ctx.harper.dataRootDir, 'cache', 'compile');
	});

	after(async () => {
		await teardownHarper(ctx);
		rmSync(scratch, { recursive: true, force: true });
	});

	test('the worker uses <rootPath>/cache/compile on a fresh install', async () => {
		const { cacheDirectory } = await probe();
		ok(cacheDirectory?.startsWith(join(cacheBase, `${process.version}-`)), cacheDirectory);
	});

	test('replacement workers from restart_service http_workers use it too', async () => {
		const before = await probe();
		const { job_id } = await sendOperation(ctx.harper, { operation: 'restart_service', service: 'http_workers' });
		const deadline = Date.now() + 60_000;
		for (;;) {
			const [job] = await sendOperation(ctx.harper, { operation: 'get_job', id: job_id });
			if (job?.status === 'COMPLETE') break;
			ok(job?.status !== 'ERROR', JSON.stringify(job));
			ok(Date.now() < deadline, `restart job did not complete: ${JSON.stringify(job)}`);
			await sleep(100);
		}
		const after = await probe();
		ok(after.threadId !== before.threadId, 'expected a replacement worker to answer');
		ok(after.cacheDirectory?.startsWith(join(cacheBase, `${process.version}-`)), after.cacheDirectory);
	});

	test('a restart enables it before bin/run.js, reuses the entries and prunes only other Node versions', async () => {
		await killHarper(ctx);
		const written = cacheEntries();
		ok(written.size > 100, `expected the stop to persist the cache, found ${written.size} entries`);
		mkdirSync(join(cacheBase, STALE));
		writeFileSync(join(cacheBase, STALE, 'entry'), 'stale');
		mkdirSync(join(cacheBase, 'not-a-node-cache'));
		writeFileSync(join(cacheBase, 'not-a-node-cache', 'entry'), 'kept');

		await startHarper(ctx, { env: harperEnv() });
		// rootPath is known before run.js loads only once the install exists
		ok(mainThreadCacheDirectory()?.startsWith(join(cacheBase, `${process.version}-`)), mainThreadCacheDirectory());
		ok((await probe()).cacheDirectory);
		await killHarper(ctx);

		// An entry V8 rejected would have been recompiled and rewritten when the threads exited.
		const rewritten = [...written].filter(([path, mtimeMs]) => statSync(path).mtimeMs !== mtimeMs);
		strictEqual(rewritten.length, 0, `entries rewritten on a warm restart: ${rewritten.map(([path]) => path)}`);
		ok(!existsSync(join(cacheBase, STALE)), 'stale Node version cache should be pruned');
		ok(existsSync(join(cacheBase, 'not-a-node-cache', 'entry')), 'a directory Node did not name must be kept');
	});

	test('NODE_DISABLE_COMPILE_CACHE turns it off', async () => {
		await startHarper(ctx, { env: harperEnv({ NODE_DISABLE_COMPILE_CACHE: '1' }) });
		strictEqual(mainThreadCacheDirectory(), null);
		strictEqual((await probe()).cacheDirectory, null);
	});
});
