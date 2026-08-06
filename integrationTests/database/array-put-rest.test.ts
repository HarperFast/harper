/**
 * Array PUT over REST — the end-to-end half of harper#2000.
 *
 * The unit tests for that fix drive `Class.put(...)` directly. This one goes through the real
 * request path, so it holds the wiring the unit tests cannot see: the deserialized array body,
 * the collection `RequestTarget` that `http.ts` infers from a trailing-slash path, and the
 * response. If a future change leaves `isCollection` unset on a parsed collection target, the
 * array is staged as one null-primary-key record again and the whole unit suite still passes —
 * this test is what fails.
 *
 * Also covers the malformed-element contract: a batch containing `null` fails whole, persists
 * nothing, and — the actual defect — does not abandon a sibling write.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/array-put-rest.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok } from 'node:assert';
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

		// Each element landed under its own id with its own fields — not one merged record.
		const one = await fetch(`${httpURL}/Batch/rest-a`, { headers: { Authorization: auth } });
		deepStrictEqual(await one.json(), { id: 'rest-a', kind: 'rest-ok', label: 'one' });
	});

	test('a malformed element fails the whole batch and persists nothing', async () => {
		const response = await putCollection([{ id: 'rest-bad-a', kind: 'rest-bad', label: 'one' }, null]);
		ok(!response.ok, `expected a failure status, got ${response.status}`);
		deepStrictEqual(await idsOf('rest-bad'), []);
	});

	test('the instance survived the malformed batch and still serves writes', async () => {
		// The regression this guards: an abandoned sibling write surfacing as an unhandled
		// rejection could take the worker down, so a healthy write after the failure is the
		// end-to-end signal that nothing was left dangling.
		const response = await putCollection([{ id: 'rest-after-a', kind: 'rest-after', label: 'still here' }]);
		ok(response.ok, `post-failure array PUT failed with ${response.status}`);
		deepStrictEqual(await idsOf('rest-after'), ['rest-after-a']);
	});
});
