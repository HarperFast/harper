/**
 * #2062 — a commit whose pre-commit blob save outruns storage.maxTransactionOpenTime.
 *
 * A blob is saved in the commit's pre-commit phase, so a write carrying a large blob stays in
 * commit() until the file has landed — for a multi-tens-of-MB deploy payload, well past the
 * limit. The long-transaction monitor used to poison the transaction there: the write was
 * dropped (while the caller was told it succeeded, since the resumed commit found an empty write
 * set) and the pre-saved blob file was unlinked, leaving a caller still holding that blob
 * instance to re-reference a destroyed file. In the field this destroyed a deploy payload and
 * the peer's install failed with `Blob file not found`, unrecoverably.
 *
 * The fixture writes a record whose blob source is trickled in after the handler returns, with
 * the limit lowered so the commit is parked across several monitor ticks. The write must commit
 * and its blob must be readable afterwards.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'blob-commit-over-time');
// Low enough that the trickled blob save crosses it several times. The monitor timer also ticks
// on this interval, so a transaction is acted on ~1-2 ticks after going over.
const MAX_TXN_OPEN_MS = 500;
const CHUNKS = 20;
const CHUNK_SIZE = 65536;
const CHUNK_DELAY_MS = 100;

suite('Blob save that outruns the open-transaction limit (#2062)', (ctx: ContextWithHarper) => {
	let httpURL: string;
	let auth: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { storage: { maxTransactionOpenTime: MAX_TXN_OPEN_MS }, logging: { level: 'warn' } },
			env: {},
		});
		httpURL = ctx.harper.httpURL;
		auth = 'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
		// Wait for the component's routes to register on the workers.
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const probe = await fetch(`${httpURL}/Doc/__seed__`, { headers: { Authorization: auth } });
			if (probe.status < 500) break;
			await sleep(250);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	function harperLog(): string {
		const logDir = (ctx.harper as any).logDir as string | undefined;
		const path = logDir && join(logDir, 'hdb.log');
		return path && existsSync(path) ? readFileSync(path, 'utf8') : '';
	}

	test('the write commits and its blob survives', async () => {
		const response = await fetch(`${httpURL}/SlowBlobWrite/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': auth },
			body: JSON.stringify({ id: 'slow-blob', chunks: CHUNKS, chunkSize: CHUNK_SIZE, chunkDelay: CHUNK_DELAY_MS }),
		});
		strictEqual(
			response.status,
			200,
			`slow blob write should commit, got ${response.status}: ${await response.text()}`
		);

		const stored = await fetch(`${httpURL}/Doc/slow-blob`, { headers: { Authorization: auth } });
		strictEqual(stored.status, 200, 'the record must have been committed');
		strictEqual((await stored.json()).size, CHUNKS * CHUNK_SIZE);

		// The blob file itself — what the abort used to unlink out from under the committed record.
		const blob = await fetch(`${httpURL}/ReadBlob/slow-blob`, { headers: { Authorization: auth } });
		strictEqual(blob.status, 200, 'the committed record must not reference a destroyed blob');
		strictEqual((await blob.json()).blobBytes, CHUNKS * CHUNK_SIZE);

		const log = harperLog();
		ok(
			!/has been aborted after exceeding the open-transaction limit/.test(log),
			'a transaction in its commit phase must not be poisoned by the monitor'
		);
		// Confirms the window was actually crossed rather than the test passing vacuously.
		ok(
			/in its commit phase past the open-transaction limit/.test(log),
			'expected the monitor to observe (and spare) the over-limit commit'
		);
	});
});
