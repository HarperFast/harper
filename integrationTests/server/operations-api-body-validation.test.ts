/**
 * A real Harper answers each Operations API body that fails validation with one 400, and the
 * validator completes the `preValidation` chain once (https://github.com/HarperFast/harper/pull/3720).
 * A second completion fails after the 400 is on its way, as an unhandled `ERR_HTTP_HEADERS_SENT`
 * in hdb.log, so each case scans the log written during a fixed window after its response.
 * `{"x":1}` cannot fail this way: its late completion meets an already-sent reply silently, and
 * unitTests/server/serverHelpers/reqBodyValidationHandler.test.js counts it at the next hook instead.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const INVALID_JSON = 'Invalid JSON.';
const MISSING_OPERATION = "Request body must include an 'operation' property.";
const SETTLE_MS = 1000;
const SECOND_RESPONSE_SIGNATURES = ['ERR_HTTP_HEADERS_SENT', 'Unhandled promise rejection'];

suite('an Operations API body that fails validation', (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let logPath: string;

	function readLog(): string {
		return readFileSync(logPath, 'utf8');
	}

	before(async () => {
		await startHarper(ctx, { config: {}, startupMaxMs: 60000 });
		client = createApiClient(ctx.harper);
		logPath = ctx.harper.logDir ? join(ctx.harper.logDir, 'hdb.log') : join(ctx.harper.dataRootDir, 'log', 'hdb.log');
		await client.req().send({ operation: 'describe_all' }).expect(200);
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			try {
				if (readLog().length > 0) break;
			} catch {}
			await sleep(100);
		}
		ok(readLog().length > 0, `${logPath} is empty after startup`);
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
