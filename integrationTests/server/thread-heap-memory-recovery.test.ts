/**
 * Regression test for harper-pro#558.
 *
 * `threads.maxHeapMemory` is passed straight to `worker_threads` as `maxOldGenerationSizeMb`.
 * A value of 1 passes config validation (`number.min(0)`) but leaves V8 unable to finish snapshot
 * deserialization, and Node aborts the whole process from `v8::Isolate::Initialize` — an
 * uncatchable native abort, not a JS error, so no restart or error handler can contain it. Because
 * `set_configuration` fans that value out to every peer with `replicated: true`, one accepted write
 * bricked every node in the cluster on the next rolling restart, with no healthy peer to recover
 * from.
 *
 * Config already on disk is an untrusted boot input, so Harper must start on it anyway. This test
 * boots with the poisoned value persisted and asserts Harper comes up and serves the operations
 * API. It has to run in its own process: on the unfixed code the failure kills the parent.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { MIN_THREAD_HEAP_MEMORY_MB } from '../../utility/hdbTerms.ts';

const RECOVERY_LOG = /Ignoring threads\.maxHeapMemory/;

async function waitForLogMatch(logDir: string, pattern: RegExp, timeoutMs = 15_000): Promise<string> {
	const logFile = join(logDir, 'hdb.log');
	const deadline = Date.now() + timeoutMs;
	let contents = '';
	while (Date.now() < deadline) {
		try {
			contents = await readFile(logFile, 'utf8');
			if (pattern.test(contents)) return contents;
		} catch {
			/* not written yet */
		}
		await sleep(200);
	}
	return contents;
}

suite('Harper boots on a threads.maxHeapMemory no worker thread could start on', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, { config: { threads: { count: 1, maxHeapMemory: 1 } }, env: {} });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('the process survives worker startup', () => {
		ok(ctx.harper.process && ctx.harper.process.exitCode === null, 'Harper process should be running');
	});

	test('the operations API serves traffic', async () => {
		const res = await fetch(`${ctx.harper.operationsAPIURL}/health`);
		strictEqual(res.status, 200);
	});

	test('the displaced value is reported', async () => {
		const logDir = ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log');
		const contents = await waitForLogMatch(logDir, RECOVERY_LOG);
		ok(RECOVERY_LOG.test(contents), `expected a recovery warning; got:\n${contents.slice(-2000)}`);
	});
});

// The accepted boundary is the one number the guard hinges on, so prove a worker actually completes
// startup there rather than only that an isolate initializes. Measured floor for a bare worker is
// between 48 (fails) and 56 (serves).
suite('Harper boots at the accepted threads.maxHeapMemory minimum', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, {
			config: { threads: { count: 1, maxHeapMemory: MIN_THREAD_HEAP_MEMORY_MB } },
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('the operations API serves traffic on the configured minimum', async () => {
		const res = await fetch(`${ctx.harper.operationsAPIURL}/health`);
		strictEqual(res.status, 200);
	});

	test('the configured minimum is honored, not displaced', async () => {
		const logDir = ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log');
		const contents = await waitForLogMatch(logDir, RECOVERY_LOG, 2000);
		ok(!RECOVERY_LOG.test(contents), 'a value at the minimum must not trigger recovery');
	});
});
