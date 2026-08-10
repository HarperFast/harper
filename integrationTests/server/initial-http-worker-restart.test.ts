import { after, before, suite, test } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/scheduler-jobs');
let crashDirectory: string;
let crashMarker: string;

// Bun cannot run this suite. Reaching the bug requires an HTTP worker to die *before* it reports
// ready, and the only way a worker can end itself that early is `process.exit()` from a component
// module that is still being evaluated. Under Bun that wedges the whole process: the main thread's
// event loop stops turning (no timers fire, no 'exit' event for the dead worker, so no restart) and
// Bun aborts with SIGABRT ~30s later. Deferring the exit by a macrotask avoids the wedge, but then
// it lands after readiness on Node and, under uWS, aborts in Node's own worker teardown
// (`node::worker::WorkerThreadData::~WorkerThreadData`) — so there is no injection point that is
// early enough everywhere. Node, Windows and uWS cover the fix.
const skipSuite = process.env.HARPER_RUNTIME === 'bun';

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

suite('HTTP worker startup recovery (#1827)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	before(async () => {
		crashDirectory = await mkdtemp(join(tmpdir(), 'harper-initial-http-worker-restart-'));
		crashMarker = join(crashDirectory, 'crashed');
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: 3 } },
			env: { HARPER_TEST_CRASH_INITIAL_HTTP_WORKER_MARKER: crashMarker },
		});
		ok(existsSync(crashMarker), 'expected the initial worker crash to be injected');
	});

	after(async () => {
		await teardownHarper(ctx);
		await rm(crashDirectory, { recursive: true, force: true });
	});

	test('reaches ready after the initial primary worker exits', async () => {
		ok(ctx.harper.startupOutput.stdout.includes('successfully started'));
		const deadline = Date.now() + 30_000;
		let ticks: any[] = [];
		let lastError: unknown;
		while (Date.now() < deadline) {
			try {
				const response = await fetch(new URL('/SchedulerTick/', ctx.harper.httpURL), {
					headers: {
						accept: 'application/json',
						authorization: basicAuth(ctx.harper.admin.username, ctx.harper.admin.password),
					},
				});
				strictEqual(response.status, 200);
				ticks = (await response.json()) as any[];
				if (ticks.some((tick) => tick.jobName === 'tick')) break;
			} catch (error) {
				// A connection refused here means the replacement worker is not accepting yet, which is
				// what the deadline is for. Keep the last one so a wholly unreachable server reports why.
				lastError = error;
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
		}
		ok(
			ticks.some((tick) => tick.jobName === 'tick'),
			`expected the replacement primary worker to run scheduler jobs${lastError ? ` (last error: ${lastError})` : ''}`
		);
	});

	// A post-ready restart satisfies the assertions above while no longer covering the bug this
	// suite exists for, so pin down that the injected exit really did land during startup.
	test(
		'the initial worker exited before it reported ready',
		{ skip: process.env.HARPER_INTEGRATION_TEST_LOG_DIR ? false : 'requires HARPER_INTEGRATION_TEST_LOG_DIR' },
		async () => {
			const log = await readFile(join(ctx.harper.logDir!, 'hdb.log'), 'utf8');
			ok(
				log.includes('HTTP worker slot 0 exited before ready'),
				'expected the crashed worker to have exited during startup, not after it was ready'
			);
		}
	);
});
