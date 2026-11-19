/**
 * With `status.drainOnLoadFailure` on, a component that fails to load on an HTTP worker takes the
 * node out of the availability GTM routes on (`get_status {id: 'availability'}`), even though
 * get_status runs on the main thread, which never runs the plugin that failed. Once the component
 * loads again the node returns to the operator's record.
 *
 * Skipped on Windows: restart_service http_workers crashes Harper on Windows (HarperFast/harper#549).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { startHarper, teardownHarper, sendOperation, type ContextWithHarper } from '@harperfast/integration-testing';

const BROKEN_APP = 'fixture-broken-one';
const BROKEN_FIXTURE = resolve(import.meta.dirname, '../fixtures/graphql-schema-failure', BROKEN_APP);

async function waitForAvailability(ctx: ContextWithHarper, expected: string) {
	const deadline = Date.now() + 60_000;
	let last;
	do {
		last = await sendOperation(ctx.harper, { operation: 'get_status', id: 'availability' });
		if (last?.status === expected) return last;
		await delay(250);
	} while (Date.now() < deadline);
	ok(false, `expected availability ${expected}, last read ${JSON.stringify(last)}`);
}

suite('drainOnLoadFailure', { skip: process.platform === 'win32' }, (ctx: ContextWithHarper) => {
	let componentsDir: string;

	before(async () => {
		const dataRootDir = await mkdtemp(
			join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
		);
		componentsDir = join(dataRootDir, 'components');
		await cp(BROKEN_FIXTURE, join(componentsDir, BROKEN_APP), { recursive: true, dereference: true });
		ctx.harper = { dataRootDir };
		await startHarper(ctx, { config: { threads: { count: 1 }, status: { drainOnLoadFailure: true } } });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a worker-side load failure overrides an Available record', async () => {
		await sendOperation(ctx.harper, { operation: 'set_status', id: 'availability', status: 'Available' });
		const availability = await waitForAvailability(ctx, 'Unavailable');
		ok(availability.message.includes(`${BROKEN_APP}.graphqlSchema`), availability.message);

		const all = await sendOperation(ctx.harper, { operation: 'get_status' });
		ok(Array.isArray(all.systemStatus), JSON.stringify(all.systemStatus));
		strictEqual(all.systemStatus.find((record: { id: string }) => record.id === 'availability')?.status, 'Unavailable');
	});

	test('the node rejoins once the component loads again', async () => {
		await writeFile(
			join(componentsDir, BROKEN_APP, 'schema.graphql'),
			'type BrokenOne @table @export {\n\tid: ID @primaryKey\n\tname: String\n}\n'
		);
		await sendOperation(ctx.harper, { operation: 'restart_service', service: 'http_workers' });
		await waitForAvailability(ctx, 'Available');
	});
});
