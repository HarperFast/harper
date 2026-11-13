/**
 * The `restart` operation stops every worker from outside. A worker serving through uWebSockets.js
 * (HARPER_UWS_HTTP) holds sockets Node cannot close for it, and stopping it with them open aborted the whole
 * process (SIGABRT) instead of exiting or relaunching (harper-pro#1347). Traffic keeps requests arriving while
 * the workers stop.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/server/uws-restart.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { ChildProcess } from 'node:child_process';

import { startHarper, teardownHarper, sendOperation, type ContextWithHarper } from '@harperfast/integration-testing';
import { waitFor } from '../../unitTests/waitFor.js';

function uwsInstalled() {
	try {
		createRequire(import.meta.url)('uWebSockets.js');
		return true;
	} catch {
		return false;
	}
}
const skipSuite =
	process.env.HARPER_RUNTIME === 'bun'
		? 'uWebSockets.js serves only on Node'
		: uwsInstalled()
			? false
			: 'uWebSockets.js is not installed for this platform';

async function exitOf(proc: ChildProcess, limitMs = 60_000) {
	if (proc.exitCode !== null || proc.signalCode !== null) return { code: proc.exitCode, signal: proc.signalCode };
	const killer = setTimeout(() => proc.kill('SIGKILL'), limitMs);
	try {
		const [code, signal] = await once(proc, 'exit');
		return { code, signal };
	} finally {
		clearTimeout(killer);
	}
}

async function servedByUws(ctx: ContextWithHarper) {
	const response = await fetch(`${ctx.harper.httpURL}/`, { signal: AbortSignal.timeout(5000) });
	await response.arrayBuffer();
	return response.headers.has('uwebsockets');
}

function startTraffic(ctx: ContextWithHarper) {
	let running = true;
	const loops = Array.from({ length: 8 }, async () => {
		while (running) {
			try {
				await (await fetch(`${ctx.harper.httpURL}/`, { signal: AbortSignal.timeout(5000) })).arrayBuffer();
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
	});
	return () => {
		running = false;
		return Promise.all(loops);
	};
}

async function readPid(ctx: ContextWithHarper) {
	try {
		return Number((await readFile(join(ctx.harper.dataRootDir, 'hdb.pid'), 'utf8')).trim()) || undefined;
	} catch {
		return undefined;
	}
}

suite('restart with HARPER_EXIT_ON_RESTART and the uWS backend', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, {
			config: { threads: { count: 2 } },
			env: { HARPER_UWS_HTTP: '1', HARPER_EXIT_ON_RESTART: 'true' },
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('exits the process cleanly while requests are arriving', async () => {
		ok(await servedByUws(ctx), 'the HTTP port is served by uWebSockets.js');
		const stopTraffic = startTraffic(ctx);
		try {
			await sendOperation(ctx.harper, { operation: 'restart' });
			deepStrictEqual(await exitOf(ctx.harper.process), { code: 0, signal: null });
		} finally {
			await stopTraffic();
		}
	});
});

suite('in-process restart with the uWS backend', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, { config: { threads: { count: 2 } }, env: { HARPER_UWS_HTTP: '1' } });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a rolling worker restart keeps the process', async () => {
		const pid = await readPid(ctx);
		const threadIds = async () =>
			(await sendOperation(ctx.harper, { operation: 'system_information', attributes: ['threads'] })).threads
				.filter((thread: { name: string }) => thread.name === 'http')
				.map((thread: { threadId: number }) => thread.threadId)
				.sort()
				.join();
		const before = await threadIds();
		const stopTraffic = startTraffic(ctx);
		try {
			await sendOperation(ctx.harper, { operation: 'restart_service', service: 'http_workers' });
			await waitFor(async () => (await threadIds()) !== before, 60_000, 250);
		} finally {
			await stopTraffic();
		}
		strictEqual(await readPid(ctx), pid);
		ok(await servedByUws(ctx));
	});

	test('relaunches a process that serves through uWebSockets.js', async () => {
		const pid = await readPid(ctx);
		ok(pid, 'the node recorded its pid');
		const stopTraffic = startTraffic(ctx);
		try {
			await sendOperation(ctx.harper, { operation: 'restart' });
			deepStrictEqual(await exitOf(ctx.harper.process), { code: 0, signal: null });
		} finally {
			await stopTraffic();
		}
		await waitFor(
			async () => {
				const relaunched = await readPid(ctx);
				if (!relaunched || relaunched === pid) return false;
				try {
					return await servedByUws(ctx);
				} catch {
					return false;
				}
			},
			90_000,
			500
		);
		notStrictEqual(await readPid(ctx), pid);
	});
});
