/**
 * #1917 — a schema error during a graphqlSchema component's initial load (bad directive, reserved
 * database name, malformed schema) used to be swallowed: handleApplication hung until the
 * component-load watchdog fired 30s later with a generic "handleApplication timed out" message that
 * named none of the actual problem. The fix rejects the load with the real error, so the component
 * fails fast and its route serves the actual cause.
 *
 * The fixture ships a syntactically malformed schema. This test asserts the failed component's route
 * returns the underlying GraphQLError, NOT a timeout — which is what distinguishes the fix from the
 * pre-fix behavior.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/components/graphql-load-error.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, './fixtures/graphql-load-error');

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

suite('graphqlSchema load error surfaces the real cause, not a timeout (#1917)', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('the failed component route reports the schema parse error', async () => {
		const res = await fetch(new URL('/Broken/', ctx.harper.httpURL), {
			headers: {
				accept: 'application/json',
				authorization: basicAuth(ctx.harper.admin.username, ctx.harper.admin.password),
			},
		});
		const body = await res.text();

		assert.strictEqual(res.status, 500, `expected the failed component to serve a 500: ${res.status} ${body}`);
		assert.match(body, /Syntax Error/, `expected the real parse error to be surfaced: ${body}`);
		// The pre-fix behavior surfaced only the watchdog timeout; guard against a regression to it.
		assert.doesNotMatch(body, /timed out/, `component-load timed out instead of failing fast: ${body}`);
	});
});
