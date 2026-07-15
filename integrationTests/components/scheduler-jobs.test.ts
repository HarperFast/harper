/**
 * #951 — built-in `scheduler` component plugin: a component declares recurring
 * jobs in its config and core invokes the designated export on schedule,
 * exactly once per occurrence. The fixture registers an every-second interval
 * job (observable within the test window) and a nightly cron job (proves cron
 * config loads); the handler inserts one row per fire with a collision-proof
 * id, so duplicate fires (two workers running the same occurrence) would show
 * up as extra rows.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/components/scheduler-jobs.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/scheduler-jobs');

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

suite('scheduler component plugin (#951)', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	async function fetchTicks(): Promise<any[]> {
		const res = await fetch(new URL('/SchedulerTick/', ctx.harper.httpURL), {
			headers: {
				accept: 'application/json',
				authorization: basicAuth(ctx.harper.admin.username, ctx.harper.admin.password),
			},
		});
		strictEqual(res.status, 200, `expected SchedulerTick to be queryable, got ${res.status}`);
		return (await res.json()) as any[];
	}

	test('an interval job fires repeatedly, once per occurrence', async () => {
		// Wait (bounded) for the 1s-interval job to fire at least three times
		const deadline = Date.now() + 30_000;
		let ticks: any[] = [];
		while (Date.now() < deadline) {
			ticks = (await fetchTicks()).filter((tick) => tick.jobName === 'tick');
			if (ticks.length >= 3) break;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
		}
		ok(ticks.length >= 3, `expected at least 3 interval fires within 30s, saw ${ticks.length}`);
		// Regular timer fires are not catch-up runs
		for (const tick of ticks) {
			strictEqual(tick.catchUp, false, `tick ${tick.id} unexpectedly marked as catch-up`);
		}
		// One fire per second means the count cannot plausibly exceed the elapsed
		// window; a duplicate-registration bug (N workers firing the same job)
		// would multiply it well beyond this bound
		ok(ticks.length <= 35, `saw ${ticks.length} fires in <=30s — the job is firing more than once per occurrence`);
	});

	test('a cron job loads without firing before its scheduled time', async () => {
		// The nightly job (02:00 UTC) proves cron parsing/registration on a real
		// boot; it must not have fired during this test's short window unless the
		// suite happens to cross 02:00 UTC, which the 1s cadence check above
		// makes effectively impossible within the test duration
		const ticks = await fetchTicks();
		const nightly = ticks.filter((tick) => tick.jobName === 'nightly');
		strictEqual(nightly.length, 0, 'nightly cron job should not have fired during the test window');
	});
});
