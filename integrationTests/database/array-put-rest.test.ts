/**
 * Array PUT over REST (harper#2000).
 *
 * Covers what a unit test calling `Class.put(...)` cannot: the deserialized array body, the
 * collection `RequestTarget` inferred from a trailing-slash path, and the response. That inference
 * is load-bearing — the same array PUT without the trailing slash is a 400, kept below as a negative
 * control — so a change that stops marking a parsed collection target as a collection fails here
 * while the unit suite, which supplies its own target, stays green.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/array-put-rest.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'array-put-rest');
const skipSuite = process.platform === 'win32';

suite('array PUT over REST (harper#2000)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let httpURL: string;
	let auth: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: { threads: { count: 2 } }, env: {} });
		const client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		auth = client.headers.Authorization;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const response = await fetch(`${httpURL}/Batch/`, {
					method: 'GET',
					headers: { Authorization: auth },
					signal: AbortSignal.timeout(3_000),
				});
				if (response.status !== 503) break;
			} catch {
				/* not ready yet */
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	});

	after(async () => teardownHarper(ctx));

	// The trailing slash is what makes this a collection target rather than a record named "Batch".
	const putCollection = (body: unknown) =>
		fetch(`${httpURL}/Batch/`, {
			method: 'PUT',
			headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});

	async function idsOf(kind: string): Promise<string[]> {
		const response = await fetch(`${httpURL}/Batch/?kind=${kind}`, {
			method: 'GET',
			headers: { Authorization: auth },
		});
		ok(response.ok, `search for ${kind} failed with ${response.status}`);
		const rows = (await response.json()) as { id: string }[];
		return rows.map((row) => row.id).sort();
	}

	test('writes every element of an array body', async () => {
		const response = await putCollection([
			{ id: 'rest-a', kind: 'rest-ok', label: 'one' },
			{ id: 'rest-b', kind: 'rest-ok', label: 'two' },
		]);
		ok(response.ok, `array PUT failed with ${response.status}: ${await response.text()}`);
		deepStrictEqual(await idsOf('rest-ok'), ['rest-a', 'rest-b']);

		// Each element under its own id with its own fields, not one merged record.
		const one = await fetch(`${httpURL}/Batch/rest-a`, { headers: { Authorization: auth } });
		deepStrictEqual(await one.json(), { id: 'rest-a', kind: 'rest-ok', label: 'one' });
	});

	// Negative control: without the trailing slash the target is not a collection, so the array is
	// staged as one record with a null primary key.
	test('the same array PUT without a collection target is rejected', async () => {
		const response = await fetch(`${httpURL}/Batch`, {
			method: 'PUT',
			headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
			body: JSON.stringify([{ id: 'rest-ns-a', kind: 'rest-ns' }]),
		});
		strictEqual(response.status, 400);
		deepStrictEqual(await idsOf('rest-ns'), []);
	});

	test('a malformed element fails the whole batch and persists nothing', async () => {
		const response = await putCollection([{ id: 'rest-bad-a', kind: 'rest-bad', label: 'one' }, null]);
		// 400, not 500, and the body names the offending position instead of relaying the raw
		// `TypeError: Cannot read properties of null` this used to surface.
		strictEqual(response.status, 400);
		const problem = (await response.json()) as { code: string; title: string };
		strictEqual(problem.code, 'ClientError');
		ok(problem.title.includes('index 1'), `expected the offending index in ${problem.title}`);
		ok(!/TypeError|Cannot read properties/.test(problem.title), `engine wording leaked: ${problem.title}`);
		deepStrictEqual(await idsOf('rest-bad'), []);
	});

	test('the instance survived the malformed batch and still serves writes', async () => {
		// Liveness only: the unit tests own the sibling-settlement assertion. This catches the worker
		// being gone after a failed batch, which is how an unhandled rejection would present.
		const response = await putCollection([{ id: 'rest-after-a', kind: 'rest-after', label: 'still here' }]);
		ok(response.ok, `post-failure array PUT failed with ${response.status}`);
		deepStrictEqual(await idsOf('rest-after'), ['rest-after-a']);
	});
});
