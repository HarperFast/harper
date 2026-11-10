/**
 * A terminating signal drains Harper instead of exiting on the spot (harper#3452): a request in flight
 * finishes, and the resources its component scope owns stay open until it has; a second signal exits at
 * once; `threads.shutdownTimeout` bounds a shutdown that never finishes.
 *
 * The probe plugin serves `/Slow/` (answers after `delayMs`, failing if its scope closed first) and
 * `/SlowStatus/` (how many `/Slow/` requests have entered). Its scope `close` listener marks the scope
 * closed and, with `hangOnClose`, never settles. One HTTP worker (or none: `threads.count: 0` serves from
 * main, which loads a plugin only with `runOnMainThread`), so both endpoints share that state. With `markerFile`,
 * `/Slow/` records its thread on entry and the time it finished, which no endpoint can report across workers.
 * `/Subscriber/` is a WebSocket that sends its thread id and stays open.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { once } from 'node:events';
import WebSocket from 'ws';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

import {
	sendOperation,
	setupHarperWithFixture,
	startHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import { waitFor } from '../../unitTests/waitFor.js';

const PLUGIN_SOURCE = `import { writeFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { Resource } from 'harper';
let scopeOpen = true;
let entered = 0;
export function handleApplication(scope) {
	const delayMs = Number(scope.options.get(['delayMs']) ?? 1500);
	const markerFile = scope.options.get(['markerFile']);
	class Slow extends Resource {
		static loadAsInstance = false;
		async get() {
			entered++;
			if (markerFile) writeFileSync(markerFile, String(threadId));
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			if (!scopeOpen) throw new Error('the scope closed before this request finished');
			if (markerFile) writeFileSync(markerFile + '.finished', String(Date.now()));
			return { completed: true };
		}
	}
	class SlowStatus extends Resource {
		static loadAsInstance = false;
		get() {
			return { entered };
		}
	}
	class Subscriber extends Resource {
		static loadAsInstance = false;
		static connect() {
			return (async function* () {
				yield { threadId };
				await new Promise(() => {});
			})();
		}
	}
	scope.resources.set('Slow', Slow);
	scope.resources.set('Subscriber', Subscriber);
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
// uWS closes its sockets at server close, and Bun's server stop has its own wait
const SKIP_WEBSOCKET_CLOSE =
	process.env.HARPER_UWS_HTTP || process.env.HARPER_RUNTIME === 'bun'
		? 'closing WebSockets at shutdown applies to the Node HTTP server'
		: false;

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

interface Subscription {
	threadId: number;
	closed: Promise<{ code: number; at: number }>;
}

async function subscribe(
	ctx: ContextWithHarper,
	url = `${ctx.harper.httpURL.replace('http', 'ws')}/Subscriber/`,
	ca?: string[]
): Promise<Subscription> {
	const socket = new WebSocket(url, {
		headers: { Authorization: authHeader(ctx), Accept: 'application/json' },
		ca,
	});
	const closed = new Promise<{ code: number; at: number }>((resolve) =>
		socket.once('close', (code) => resolve({ code, at: Date.now() }))
	);
	// a socket reset by the exiting server still reports its close code
	socket.on('error', () => {});
	const [message] = await Promise.race([
		once(socket, 'message', { signal: AbortSignal.timeout(10_000) }),
		closed.then(({ code }) => Promise.reject(new Error(`subscriber closed with ${code} before its first message`))),
	]);
	return { threadId: JSON.parse(message.toString()).threadId, closed };
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
				if (fixtureParent) await rm(fixtureParent, { recursive: true, force: true });
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

			test(
				'a WebSocket subscriber does not hold the stop, and sees the server going away',
				{ skip: SKIP_WEBSOCKET_CLOSE },
				async () => {
					const proc = ctx.harper.process;
					const { closed } = await subscribe(ctx);
					const signalledAt = Date.now();
					proc.kill('SIGTERM');
					strictEqual((await closed).code, 1001);
					const exit = await exitOf(proc, signalledAt);
					deepStrictEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null });
					ok(exit.afterMs < 5000, `stop with a subscriber took ${exit.afterMs} ms`);
					const log = await hdbLog(ctx);
					ok(!log.includes('Had to forcefully exit'), 'no server rode the close timer');
				}
			);
		}
	);
}

suite(
	'a WebSocket outlives a request on another thread',
	{
		skip:
			SKIP_SIGNALS ||
			SKIP_WEBSOCKET_CLOSE ||
			(process.platform === 'darwin' && 'one worker binds each port on macOS, so nothing lands on another thread'),
	},
	(ctx: ContextWithHarper) => {
		let fixtureParent: string;
		let markerFile: string;
		before(async () => {
			fixtureParent = await mkdtemp(join(tmpdir(), 'harper-graceful-shutdown-'));
			markerFile = join(fixtureParent, 'slow-request');
			await setupHarperWithFixture(ctx, await writeProbeApp(fixtureParent, { delayMs: 2000, markerFile }), {
				config: { threads: { count: 2 } },
				env: {},
			});
		});
		after(async () => {
			await teardownHarper(ctx);
			if (fixtureParent) await rm(fixtureParent, { recursive: true, force: true });
		});

		test('no subscriber closes before the request finishes, and each then sees 1001', async () => {
			const subscriptions: Subscription[] = [];
			const threads = new Set<number>();
			for (let i = 0; i < 64 && threads.size < 2; i++) {
				const subscription = await subscribe(ctx);
				subscriptions.push(subscription);
				threads.add(subscription.threadId);
			}
			strictEqual(threads.size, 2, 'subscribers landed on both HTTP workers');

			const proc = ctx.harper.process;
			const pending = appGet(ctx, '/Slow/');
			await waitFor(async () => (await readFile(markerFile, 'utf8').catch(() => '')) !== '', { timeout: 10_000 });
			const signalledAt = Date.now();
			proc.kill('SIGTERM');
			strictEqual((await pending).status, 200);
			const finishedAt = Number(await readFile(`${markerFile}.finished`, 'utf8'));
			for (const { closed } of subscriptions) {
				const { code, at } = await closed;
				strictEqual(code, 1001);
				ok(at >= finishedAt, `a subscriber closed ${finishedAt - at} ms before the request finished`);
			}
			const exit = await exitOf(proc, signalledAt);
			deepStrictEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null });
			ok(exit.afterMs < 5000, `exited ${exit.afterMs} ms after SIGTERM`);
		});
	}
);

suite(
	'WebSockets with http2 enabled across multiple threads',
	{
		skip:
			SKIP_SIGNALS ||
			SKIP_WEBSOCKET_CLOSE ||
			(process.platform === 'darwin' && 'one worker binds each port on macOS, so nothing lands on another thread'),
	},
	(ctx: ContextWithHarper) => {
		const config = { http: { http2: true }, tls: {}, threads: { count: 2 } };
		let fixtureParent: string;
		before(async () => {
			fixtureParent = await mkdtemp(join(tmpdir(), 'harper-graceful-shutdown-'));
			await setupHarperWithFixture(ctx, await writeProbeApp(fixtureParent, {}), {
				config,
				env: {},
			});
		});
		after(async () => {
			await teardownHarper(ctx);
			if (fixtureParent) await rm(fixtureParent, { recursive: true, force: true });
		});

		test('every subscriber across both threads sees 1001 on repeated SIGTERM stops', async () => {
			const rows = (await sendOperation(ctx.harper, {
				operation: 'search_by_value',
				database: 'system',
				table: 'hdb_certificate',
				search_attribute: 'name',
				search_value: '*',
				get_attributes: ['certificate'],
			})) as { certificate: string }[];
			const ca = rows.map((row) => row.certificate);
			const wssUrl = `wss://${ctx.harper.hostname}:9927/Subscriber/`;
			for (let stop = 0; stop < 4; stop++) {
				if (stop > 0) {
					await startHarper(ctx, { config, env: {} });
				}
				const subscriptions: Subscription[] = [];
				const threads = new Set<number>();
				for (let i = 0; i < 64 && threads.size < 2; i++) {
					const subscription = await subscribe(ctx, i % 2 === 0 ? wssUrl : undefined, ca);
					subscriptions.push(subscription);
					threads.add(subscription.threadId);
				}
				strictEqual(threads.size, 2, `stop ${stop + 1}: subscribers landed on both HTTP workers`);

				const proc = ctx.harper.process;
				const signalledAt = Date.now();
				proc.kill('SIGTERM');
				for (const { closed } of subscriptions) {
					const { code } = await closed;
					strictEqual(code, 1001, `stop ${stop + 1}: subscriber received close code ${code}`);
				}
				const exit = await exitOf(proc, signalledAt);
				deepStrictEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null });
				ok(exit.afterMs < 7500, `stop ${stop + 1}: exited ${exit.afterMs} ms after SIGTERM`);
			}
		});
	}
);

suite(
	'a signal during a rolling restart',
	{
		skip:
			SKIP_SIGNALS ||
			SKIP_WEBSOCKET_CLOSE ||
			(process.platform === 'darwin' && 'the replacement starts after the worker retires on macOS'),
	},
	(ctx: ContextWithHarper) => {
		let fixtureParent: string;
		before(async () => {
			fixtureParent = await mkdtemp(join(tmpdir(), 'harper-graceful-shutdown-'));
			await setupHarperWithFixture(ctx, await writeProbeApp(fixtureParent, {}), {
				config: { threads: { count: 1 } },
				env: {},
			});
		});
		after(async () => {
			await teardownHarper(ctx);
			if (fixtureParent) await rm(fixtureParent, { recursive: true, force: true });
		});

		test('a retiring worker still closes its subscribers', async () => {
			const proc = ctx.harper.process;
			const retiring = await subscribe(ctx);
			// its response can be lost with the worker that serves it
			sendOperation(ctx.harper, { operation: 'restart_service', service: 'http_workers' }).catch(() => {});
			await waitFor(
				// a probe arriving right as the retiring worker closes its listener can be reset before its first message
				async () =>
					subscribe(ctx).then(
						({ threadId }) => threadId !== retiring.threadId,
						() => false
					),
				{ timeout: 30_000 }
			);
			// the worker retires once its replacement is up, then holds its subscriber for 5 s: signal inside that hold
			await delay(500);
			const signalledAt = Date.now();
			proc.kill('SIGTERM');
			const { code, at } = await retiring.closed;
			strictEqual(code, 1001);
			ok(at - signalledAt < 2500, `the subscriber closed ${at - signalledAt} ms after SIGTERM`);
		});
	}
);

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
		if (fixtureParent) await rm(fixtureParent, { recursive: true, force: true });
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
