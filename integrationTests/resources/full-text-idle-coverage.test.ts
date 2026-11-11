/**
 * Nothing may search either index before the idle period: a first search with a reader, or with the last
 * owner's coverage clock inside the 3000 ms default tolerance, would pass without the idle-release proof.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { waitFor } from '../../unitTests/waitFor.js';

const FIXTURE_PATH = resolve(import.meta.dirname, 'full-text-idle-coverage');

suite('first full-text searches after an idle owner release', (ctx: ContextWithHarper) => {
	let authorization: string;

	async function request(path: string, init: RequestInit = {}) {
		const response = await fetch(`${ctx.harper.httpURL}${path}`, {
			...init,
			headers: { 'Authorization': authorization, 'Content-Type': 'application/json' },
			signal: AbortSignal.timeout(45_000),
		});
		// A search that fails after its headers aborts the stream; keep what arrived for the assertion.
		let text = '';
		let aborted: unknown;
		const decoder = new TextDecoder();
		try {
			for await (const chunk of response.body ?? []) text += decoder.decode(chunk, { stream: true });
		} catch (error) {
			aborted = error;
		}
		return { status: response.status, coverage: response.headers.get('harper-index-coverage'), text, aborted };
	}

	function assertAnswered(result: Awaited<ReturnType<typeof request>>, ids: string[]) {
		assert.ok(!result.aborted && result.status === 200, `${result.status}, aborted after: ${result.text}`);
		assert.deepStrictEqual(
			JSON.parse(result.text),
			ids.map((id) => ({ id }))
		);
		assert.strictEqual(result.coverage, 'current; lag=0; tolerance=3000');
	}

	async function operation(body: Record<string, unknown>) {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Authorization': authorization, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(45_000),
		});
		const text = await response.text();
		assert.strictEqual(response.status, 200, `operation ${body.operation}: ${text}`);
		return JSON.parse(text);
	}

	const readiness = async () =>
		Object.fromEntries(
			(await operation({ operation: 'describe_table', schema: 'data', table: 'IdleArticle' })).full_text_indexes.map(
				({ name, readiness }) => [name, readiness]
			)
		);

	const runnersFree = async () => {
		const { status, text } = await request('/IdleRunners/');
		assert.strictEqual(status, 200, text);
		return Object.values(JSON.parse(text)).every(Boolean);
	};

	const search = (attribute: string, condition: Record<string, unknown> = {}) =>
		request('/IdleArticle/', {
			method: 'QUERY',
			body: JSON.stringify({
				conditions: [{ attribute, comparator: 'matches', value: 'lighthouse', ...condition }],
				select: ['id'],
			}),
		});

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: 2 } },
			env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
		});
		authorization = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('answers the first plain and scoring default searches with current coverage', { timeout: 300_000 }, async () => {
		await waitFor(async () => Object.values(await readiness()).every(({ state }) => state === 'ready'), {
			timeout: 60_000,
			message: 'the full-text indexes did not become ready',
		});
		await operation({
			operation: 'insert',
			schema: 'data',
			table: 'IdleArticle',
			records: [
				{ id: 'keeper', title: 'Lighthouse keeper', body: 'Harbor fog' },
				{ id: 'master', title: 'Harbor master', body: 'Lighthouse beam' },
			],
		});
		// Models the runner's 30 s idle grace after it indexed the insert; the release itself is polled next.
		await delay(31_000);
		await waitFor(runnersFree, { timeout: 60_000, message: 'the idle owners did not release' });
		const epochs = await readiness();
		// Ages the last owner's coverage clock past the 3000 ms default tolerance.
		await delay(3_200);

		assertAnswered(await search('titleSearch'), ['keeper']);
		assertAnswered(await search('bodySearch', { boost: 2 }), ['master']);

		assert.deepStrictEqual(await readiness(), epochs, 'the searches took no ownership');
		assert.ok(await runnersFree(), 'no runner acquired an idle index for a search');
	});
});
