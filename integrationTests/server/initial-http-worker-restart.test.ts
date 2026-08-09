import { after, before, suite, test } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/scheduler-jobs');
let crashDirectory: string;
let crashMarker: string;

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

suite('HTTP worker startup recovery (#1827)', (ctx: ContextWithHarper) => {
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
		while (Date.now() < deadline) {
			const response = await fetch(new URL('/SchedulerTick/', ctx.harper.httpURL), {
				headers: {
					accept: 'application/json',
					authorization: basicAuth(ctx.harper.admin.username, ctx.harper.admin.password),
				},
			});
			strictEqual(response.status, 200);
			ticks = (await response.json()) as any[];
			if (ticks.some((tick) => tick.jobName === 'tick')) break;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
		}
		ok(
			ticks.some((tick) => tick.jobName === 'tick'),
			'expected the replacement primary worker to run scheduler jobs'
		);
	});
});
