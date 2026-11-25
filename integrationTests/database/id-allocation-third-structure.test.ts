/**
 * Auto-assigned Int ids in a table that already holds two record shapes (harper#1762): the stored id range is then
 * the table's third classic record structure, 0x42, which is also how a RocksDB version header starts.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'id-allocation-third-structure');
const BOOT_CONFIG = { threads: { count: 1 } };
const BULK_ROWS = 1500;

function authorization(ctx: ContextWithHarper): string {
	const { username, password } = ctx.harper.admin;
	return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

async function operation(ctx: ContextWithHarper, body: object): Promise<{ status: number; body: any }> {
	const response = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': authorization(ctx) },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
	});
	const text = await response.text();
	return { status: response.status, body: text && JSON.parse(text) };
}

function rest(ctx: ContextWithHarper, path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(new URL(path, ctx.harper.httpURL), {
		...init,
		headers: { 'Content-Type': 'application/json', 'Authorization': authorization(ctx), ...init.headers },
		signal: AbortSignal.timeout(60_000),
	});
}

async function waitForTable(ctx: ContextWithHarper): Promise<void> {
	const deadline = Date.now() + 60_000;
	let last = '';
	while (Date.now() < deadline) {
		try {
			const response = await rest(ctx, '/IdRows/');
			last = `${response.status} ${await response.text()}`;
			if (response.status === 200) return;
		} catch (error) {
			last = String(error);
		}
		await sleep(250);
	}
	throw new Error(`/IdRows/ did not serve within 60s; last response: ${last}`);
}

async function insertWithoutIds(ctx: ContextWithHarper, prefix: string): Promise<void> {
	const records = Array.from({ length: BULK_ROWS }, (_, i) => ({ a: `${prefix}${i}` }));
	const { status, body } = await operation(ctx, { operation: 'insert', database: 'data', table: 'IdRows', records });
	strictEqual(status, 200, `insert: ${status} ${JSON.stringify(body)}`);
	strictEqual(body.inserted_hashes.length, BULK_ROWS, body.message);
}

async function postWithoutId(ctx: ContextWithHarper, a: string): Promise<void> {
	const response = await rest(ctx, '/IdRows/', { method: 'POST', body: JSON.stringify({ a }) });
	strictEqual(response.status, 201, `POST /IdRows/: ${response.status} ${await response.text()}`);
}

suite(
	'auto-assigned ids when the id range is the third record structure (harper#1762)',
	{ timeout: 300_000 },
	(ctx: ContextWithHarper) => {
		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: BOOT_CONFIG, env: {} });
			await waitForTable(ctx);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('a bulk insert and POSTs get unique ids, before and after a restart', async () => {
			for (const [id, record] of [
				[1, { id: 1, a: 'first shape' }],
				[2, { id: 2, b: 'second shape' }],
			] as const) {
				const response = await rest(ctx, `/IdRows/${id}`, { method: 'PUT', body: JSON.stringify(record) });
				ok(response.status < 300, `PUT /IdRows/${id}: ${response.status} ${await response.text()}`);
			}
			await insertWithoutIds(ctx, 'bulk');
			await postWithoutId(ctx, 'posted');

			await killHarper(ctx);
			await startHarper(ctx, { config: BOOT_CONFIG, env: {} });
			await waitForTable(ctx);
			await insertWithoutIds(ctx, 'restarted');
			await postWithoutId(ctx, 'restarted post');

			const { status, body } = await operation(ctx, {
				operation: 'search_by_value',
				database: 'data',
				table: 'IdRows',
				search_attribute: 'id',
				search_value: '*',
				get_attributes: ['id', 'a', 'b'],
			});
			strictEqual(status, 200, JSON.stringify(body));
			// a reissued id overwrites an earlier row
			strictEqual(body.length, 2 * BULK_ROWS + 4, 'rows were lost or overwritten');
			const generatedIds = (restarted: boolean) =>
				body.filter((row: any) => row.id > 2 && row.a.startsWith('restarted') === restarted).map((row: any) => row.id);
			ok(
				Math.min(...generatedIds(true)) > Math.max(...generatedIds(false)),
				'the restart did not continue the stored range'
			);
		});
	}
);
