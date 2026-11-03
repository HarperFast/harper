/**
 * A terminating signal drains Harper instead of exiting on the spot (harper#3452): a request in flight
 * finishes, and the resources its component scope owns stay open until it has; a second signal exits at
 * once; `threads.shutdownTimeout` bounds a shutdown that never finishes.
 *
 * The probe plugin serves `/Slow/` (answers after `delayMs`, failing if its scope closed first) and
 * `/SlowStatus/` (how many `/Slow/` requests have entered). Its scope `close` listener marks the scope
 * closed and, with `hangOnClose`, never settles. One HTTP worker (or none: `threads.count: 0` serves from
 * main, which loads a plugin only with `runOnMainThread`), so both endpoints share that state.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

import {
	setupHarperWithFixture,
	startHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import { waitFor } from '../../unitTests/waitFor.js';

const PLUGIN_SOURCE = `import { Resource } from 'harper';
let scopeOpen = true;
let entered = 0;
export function handleApplication(scope) {
	const delayMs = Number(scope.options.get(['delayMs']) ?? 1500);
	class Slow extends Resource {
		static loadAsInstance = false;
		async get() {
			entered++;
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			if (!scopeOpen) throw new Error('the scope closed before this request finished');
			return { completed: true };
		}
	}
	class SlowStatus extends Resource {
		static loadAsInstance = false;
		get() {
			return { entered };
		}
	}
	scope.resources.set('Slow', Slow);
	scope.resources.set('SlowStatus', SlowStatus);
	scope.on('close', () => {
		scopeOpen = false;
		// a disposal that never finishes holds a live handle, as a stuck native runtime would
		if (scope.options.get(['hangOnClose'])) return new Promise(() => setInterval(() => {}, 1000));
	});
}
`;

async function writeProbeApp(parent: string, probeOptions: Record<string, unknown>): Promise<string> {
	const app = join(parent, 'shutdown-probe-app');
	const plugin = join(app, 'node_modules', 'shutdown-probe');
	await mkdir(plugin, { recursive: true });
	const options = Object.entries({ package: 'shutdown-probe', ...probeOptions })
		.map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`)
		.join('\n');
	await writeFile(join(app, 'config.yaml'), `rest: true\nshutdown-probe:\n${options}\n`);
	await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'shutdown-probe-app', version: '1.0.0' }));
	await writeFile(
		join(plugin, 'package.json'),
		JSON.stringify({ name: 'shutdown-probe', version: '1.0.0', type: 'module' })
	);
	await writeFile(join(plugin, 'config.yaml'), 'pluginModule: plugin.js\nrunOnMainThread: true\n');
	await writeFile(join(plugin, 'plugin.js'), PLUGIN_SOURCE);
	return app;
}

// Windows delivers no POSIX signal: child.kill('SIGTERM') there is TerminateProcess, so no handler runs
const SKIP_SIGNALS = process.platform === 'win32' ? 'Windows cannot deliver SIGTERM to a handler' : false;

function authHeader(ctx: ContextWithHarper) {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

function appGet(ctx: ContextWithHarper, path: string) {
	return fetch(`${ctx.harper.httpURL}${path}`, {
		headers: { Authorization: authHeader(ctx) },
		signal: AbortSignal.timeout(30_000),
	});
}

interface Exit {
	code: number | null;
	signal: NodeJS.Signals | null;
	afterMs: number;
}

async function exitOf(proc: ChildProcess, since: number, limitMs = 30_000): Promise<Exit> {
	if (proc.exitCode !== null || proc.signalCode !== null)
		return { code: proc.exitCode, signal: proc.signalCode, afterMs: Date.now() - since };
	const killer = setTimeout(() => proc.kill('SIGKILL'), limitMs);
	try {
		const [code, signal] = await once(proc, 'exit');
		return { code, signal, afterMs: Date.now() - since };
	} finally {
		clearTimeout(killer);
	}
}

async function stillRunningAfter(proc: ChildProcess, ms: number): Promise<boolean> {
	const exited = once(proc, 'exit').then(() => false);
	return Promise.race([exited, new Promise<boolean>((resolve) => setTimeout(resolve, ms, true))]);
}

async function enteredCount(ctx: ContextWithHarper): Promise<number> {
	const response = await appGet(ctx, '/SlowStatus/');
	return (await response.json()).entered;
}

/** This boot's log: the harness gives each boot its own directory when HARPER_INTEGRATION_TEST_LOG_DIR is set. */
function hdbLogPath(ctx: ContextWithHarper) {
	return join(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'), 'hdb.log');
}

function hdbLog(ctx: ContextWithHarper) {
	return readFile(hdbLogPath(ctx), 'utf8');
}

for (const threadCount of [1, 0]) {
	suite(
		`SIGTERM drains an in-flight request (threads.count: ${threadCount})`,
		{ skip: SKIP_SIGNALS },
		(ctx: ContextWithHarper) => {
			let fixtureParent: string;
			before(async () => {
				fixtureParent = await mkdtemp(join(tmpdir(), 'harper-graceful-shutdown-'));
				await setupHarperWithFixture(ctx, await writeProbeApp(fixtureParent, { delayMs: 1500 }), {
					config: { threads: { count: threadCount } },
					env: {},
				});
			});
			after(async () => {
				await teardownHarper(ctx);
				await rm(fixtureParent, { recursive: true, force: true });
			});

			test(
				'the request completes with its scope still open, then the process exits 0',
				// the uWS shim's close() is uWS App.close(), which drops connections still in flight
				{ skip: process.env.HARPER_UWS_HTTP ? 'uWS closes in-flight requests at server close' : false },
				async () => {
					const proc = ctx.harper.process;
					const pending = appGet(ctx, '/Slow/');
					await waitFor(async () => (await enteredCount(ctx)) > 0, { timeout: 10_000 });
					const signalledAt = Date.now();
					proc.kill('SIGTERM');
					const response = await pending;
					strictEqual(response.status, 200);
					deepStrictEqual(await response.json(), { completed: true });
					const exit = await exitOf(proc, signalledAt);
					deepStrictEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null });
					ok(exit.afterMs < 8000, `exited ${exit.afterMs} ms after SIGTERM`);
					ok((await hdbLog(ctx)).includes('Received SIGTERM; shutting down'), 'the graceful path logged its start');
				}
			);

			test('an idle instance stops well inside a 5 s grace and restarts without replaying its log', async () => {
				if (ctx.harper.process.exitCode === null && ctx.harper.process.signalCode === null) {
					ctx.harper.process.kill('SIGTERM');
					await exitOf(ctx.harper.process, Date.now());
				}
				await startHarper(ctx, { config: { threads: { count: threadCount } }, env: {} });
				const proc = ctx.harper.process;
				const signalledAt = Date.now();
				proc.kill('SIGTERM');
				const exit = await exitOf(proc, signalledAt);
				deepStrictEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null });
				ok(exit.afterMs < 5000, `idle stop took ${exit.afterMs} ms`);
				ok((await hdbLog(ctx)).includes('Shutdown complete'), 'the graceful path logged its end');
				const stoppedBootLog = hdbLogPath(ctx);
				await startHarper(ctx, { config: { threads: { count: threadCount } }, env: {} });
				// a restarted boot may keep writing to the first boot's log, so read both; the harness returns on
				// the stdout "started" line, which can land before the same notice reaches hdb.log
				const bootLogs = [...new Set([stoppedBootLog, hdbLogPath(ctx)])];
				let logs = '';
				await waitFor(
					async () => {
						logs = (await Promise.all(bootLogs.map((path) => readFile(path, 'utf8').catch(() => '')))).join('');
						return (logs.match(/Harper successfully started/g)?.length ?? 0) >= 2;
					},
					{ timeout: 15_000, message: () => `the restarted boot never logged its start in ${bootLogs.join(', ')}` }
				);
				ok(!/Replayed \d+ records/.test(logs), 'no transaction-log replay after a clean stop');
			});
		}
	);
}

suite('a scope close that never finishes', { skip: SKIP_SIGNALS }, (ctx: ContextWithHarper) => {
	let fixtureParent: string;
	before(async () => {
		fixtureParent = await mkdtemp(join(tmpdir(), 'harper-graceful-shutdown-'));
		await setupHarperWithFixture(ctx, await writeProbeApp(fixtureParent, { hangOnClose: true }), {
			config: { threads: { count: 1, shutdownTimeout: 60_000 } },
			env: {},
		});
	});
	after(async () => {
		await teardownHarper(ctx);
		await rm(fixtureParent, { recursive: true, force: true });
	});

	test('holds the first SIGTERM, and a second signal exits 0 at once', async () => {
		const proc = ctx.harper.process;
		proc.kill('SIGTERM');
		ok(await stillRunningAfter(proc, 2000), 'the first signal waits for the shutdown');
		const secondAt = Date.now();
		proc.kill('SIGINT');
		const exit = await exitOf(proc, secondAt);
		deepStrictEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null });
		ok(exit.afterMs < 3000, `exited ${exit.afterMs} ms after the second signal`);
	});

	test('threads.shutdownTimeout ends the wait', async () => {
		await startHarper(ctx, { config: { threads: { count: 1, shutdownTimeout: 3000 } }, env: {} });
		const proc = ctx.harper.process;
		const signalledAt = Date.now();
		proc.kill('SIGTERM');
		const exit = await exitOf(proc, signalledAt);
		deepStrictEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null });
		ok(exit.afterMs >= 2500 && exit.afterMs < 8000, `exited ${exit.afterMs} ms after SIGTERM`);
		ok((await hdbLog(ctx)).includes('Shutdown did not finish within 3000 ms'), 'the deadline was logged');
	});
});
