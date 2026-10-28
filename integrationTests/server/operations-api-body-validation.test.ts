/**
 * An Operations API body that fails validation is answered with one 400 and goes no further: the
 * authentication hook and the operation handler never see it, and hdb.log records no second response attempt.
 *
 * Run:
 *   npm run build && npm run test:integration -- "integrationTests/server/operations-api-body-validation.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const INVALID_JSON = 'Invalid JSON.';
const MISSING_OPERATION = "Request body must include an 'operation' property.";
const SETTLE_MS = 1000;
const SECOND_RESPONSE_SIGNATURES = ['ERR_HTTP_HEADERS_SENT', 'Unhandled promise rejection', 'Reply was already sent'];

suite('an Operations API body that fails validation', (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let logPath: string;

	function readLog(): string {
		return existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
	}

	before(async () => {
		await startHarper(ctx, { config: {}, startupMaxMs: 60000 });
		client = createApiClient(ctx.harper);
		logPath = ctx.harper.logDir ? join(ctx.harper.logDir, 'hdb.log') : join(ctx.harper.dataRootDir, 'log', 'hdb.log');
		await client.req().send({ operation: 'describe_all' }).expect(200);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	const refused: [string, string, string][] = [
		['an empty object', '{}', INVALID_JSON],
		['an object without an operation', '{"x":1}', MISSING_OPERATION],
		['null', 'null', INVALID_JSON],
		['an empty array', '[]', INVALID_JSON],
		['a string', '"a string"', INVALID_JSON],
		['a number', '5', INVALID_JSON],
	];

	for (const [description, payload, message] of refused) {
		test(`${description} gets one 400 and leaves no second response attempt in the log`, async () => {
			const offset = readLog().length;

			const response = await client.req().send(payload);
			// A duplicate completion fails after the response is on its way, so wait out a bounded window.
			await sleep(SETTLE_MS);
			const written = readLog().slice(offset);

			for (const signature of SECOND_RESPONSE_SIGNATURES) {
				ok(!written.includes(signature), `${signature} was logged after a rejected body:\n${written}`);
			}
			strictEqual(response.status, 400, response.text);
			strictEqual(response.text, JSON.stringify({ error: message }));
		});
	}
});
