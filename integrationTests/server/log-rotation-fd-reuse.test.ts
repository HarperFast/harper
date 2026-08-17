/**
 * QA-686 — log rotation `maxSize` unit-parsing + on-disk enforcement probe (gh#1877,
 * source:gh:1877, labelled `bug`, "Log rotation maxSize not respected properly").
 *
 * Prior QA on this same issue (already in this scratch dir) established:
 *   - QA-628 (qa628-external-log-rotation.test.ts): a `logging.external` block with no OWN
 *     `rotation` sub-key unconditionally clobbers the inherited rotator -> that logger's file
 *     NEVER rotates. Root-caused to harper_logger.ts updateLogger()/getFileLogger().
 *   - QA-542 (qa542-log-rotator-fd.test.ts): a prior FD-leak-on-rotate bug (harper#683) is fixed
 *     in this build (moveLogFile() closes the rotating logger's OWN fd).
 *   - QA-655 (qa655-log-rotation.test.ts): on the MAIN log, rotation is checked on a fixed 60s
 *     `setInterval` tick (LOG_AUDIT_INTERVAL, not configurable), and the check is a single `if`,
 *     not a loop — so the real ceiling on peak active-file size is ~(write-rate * 60s), not
 *     `maxSize`, under sustained load. Worker threads (threads.count>1) share one physical log
 *     file via separate FDs, but only the main thread ever builds a `logRotator`.
 *
 * This test covers UNEXPLORED ground: Q3 from the task brief — does maxSize UNIT PARSING itself
 * matter, and is a bad unit silently ignored/misparsed (the task's suggested hypothesis) or
 * rejected loudly? Then re-verifies Q1/Q2 (actual on-disk bytes vs configured maxSize) with a
 * fresh, independently-generated, non-blind measurement on a WELL-FORMED config.
 *
 * SOURCE READ (harper @ 2615b092b):
 *   - config-root.schema.json logging.rotation.maxSize: `{"type": ["string","null"], ...
 *     "e.g. '100M', '1G'"}` — string-only by schema; only a suffixed string is documented.
 *   - validation/configValidator.ts validateRotationMaxSize() (~line 416):
 *       `const unit = value.slice(-1); if (unit !== 'G' && unit !== 'M' && unit !== 'K') reject;`
 *     i.e. Joi's `string.custom()` — a raw JS number fails Joi's base `string()` type check
 *     first ("maxSize must be a string"); a string with any suffix other than exactly 'G'/'M'/'K'
 *     (case-sensitive — 'k'/'m'/'g' rejected, 'MB'/'mb' rejected because the unit check only
 *     looks at the LAST character, which is 'B'/'b') is rejected with INVALID_SIZE_UNIT_MSG.
 *   - config/configUtils.ts initConfig() calls validateConfig() -> configValidator() on EVERY
 *     boot (not just first install) — a bad value throws HDB_ERROR_MSGS.CONFIG_VALIDATION, which
 *     environmentManager.initSync()'s catch turns into `process.exit(1)` (loud, fail-closed).
 *   - utility/logging/logRotator.ts (~line 51-57) does its OWN independent unit parsing on the
 *     (already-validated) string: `unit = maxSize.slice(-1); size = maxSize.slice(0,-1);
 *     if (unit==='G') *1e9; else if (unit==='M') *1e6; else *1e3` — this SILENTLY treats any
 *     value the validator let through that ISN'T 'G'/'M' as kilobytes (matches, since the
 *     validator restricts to G/M/K), so validator and rotator agree for values that pass
 *     validation. The two layers are consistent — the interesting empirical question is whether
 *     malformed forms are caught at layer 1 (config validation, loud) or fall through to layer 2
 *     (rotator, where `"1M" * 1000000` on a non-numeric-prefixed string would coerce to `NaN`,
 *     and `size >= NaN` is always false — silent, permanent disablement of size-based rotation).
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/server/log-rotation-fd-reuse.test.ts"
 * Harper SHA: 2615b092b89636c0656beb3816db2e5f4edc0e72 (already built — do NOT rebuild)
 */
import { suite, test, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { statSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	teardownHarper,
	HarperStartupError,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from './../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'log-rotation-fd-reuse');
const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

// Decimal units in logRotator.ts / configValidator.ts (K = *1000, not *1024).
const MAX_SIZE = '64K';
const MAX_BYTES = 64_000;
const ROTATED_SUBDIR = 'qa686-rotated';
const RETENTION = '10m';

const PADDING_LEN = 500; // must match resources.js PADDING
const LINES_PER_REQUEST = 6; // must match resources.js

// > 1x the fixed 60s audit tick, so at least one rotation happens under continuous load.
const LOAD_DURATION_MS = 75_000;
const POLL_INTERVAL_MS = 3_000;

function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return -1;
	}
}

function rotatedFiles(dir: string): { name: string; size: number }[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.startsWith('HDB-'))
			.map((name) => ({ name, size: fileSize(join(dir, name)) }));
	} catch {
		return [];
	}
}

suite(
	'QA-686 log rotation maxSize unit parsing + enforcement [gh#1877]',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		after(async () => {
			await teardownHarper(ctx as any);
		});

		// ---- Q3a: a raw numeric byte value (no unit) ------------------------------------------
		test('Q3a: numeric maxSize (byte value, no unit) is rejected at boot, not silently coerced', async () => {
			let startupErr: any;
			try {
				await setupHarperWithFixture(ctx, FIXTURE_PATH, {
					config: { logging: { rotation: { enabled: true, maxSize: 65536 } } },
					env: {},
				});
			} catch (err) {
				startupErr = err;
			} finally {
				await teardownHarper(ctx as any).catch(() => {});
			}
			const text = `${startupErr?.stdout ?? ''}\n${startupErr?.stderr ?? ''}`;
			console.log(
				`[QA-686 Q3a] maxSize=65536 (number) -> ${
					startupErr instanceof HarperStartupError ? 'BOOT REJECTED (loud)' : 'BOOT SUCCEEDED (unexpected)'
				}`
			);
			if (startupErr) console.log(`  error tail: ${text.slice(-400).replace(/\n+/g, ' | ')}`);
			ok(startupErr instanceof HarperStartupError, 'numeric maxSize should fail Harper boot (config validation)');
			ok(/maxSize/i.test(text), `boot-failure text should reference maxSize; got: ${text.slice(-400)}`);
		});

		// ---- Q3b: malformed unit strings -------------------------------------------------------
		test('Q3b: malformed unit strings ("1MB", "1mb", "64k") are rejected at boot, not silently misparsed', async () => {
			for (const bad of ['1MB', '1mb', '64k']) {
				let startupErr: any;
				try {
					await setupHarperWithFixture(ctx, FIXTURE_PATH, {
						config: { logging: { rotation: { enabled: true, maxSize: bad } } },
						env: {},
					});
				} catch (err) {
					startupErr = err;
				} finally {
					await teardownHarper(ctx as any).catch(() => {});
				}
				const text = `${startupErr?.stdout ?? ''}\n${startupErr?.stderr ?? ''}`;
				console.log(
					`[QA-686 Q3b] maxSize="${bad}" -> ${
						startupErr instanceof HarperStartupError ? 'BOOT REJECTED (loud)' : 'BOOT SUCCEEDED (unexpected)'
					}`
				);
				ok(startupErr instanceof HarperStartupError, `maxSize="${bad}" should fail Harper boot (config validation)`);
				ok(/maxSize/i.test(text), `boot-failure text should reference maxSize for "${bad}"; got: ${text.slice(-400)}`);
			}
		});

		// ---- Q1/Q2: well-formed maxSize, independently measured -------------------------------
		test(
			'Q1/Q2: well-formed maxSize is accepted (verified via get_configuration) and actual on-disk sizes are measured',
			{ timeout: 200_000 },
			async () => {
				await setupHarperWithFixture(ctx, FIXTURE_PATH, {
					config: {
						logging: {
							level: 'error',
							rotation: {
								enabled: true,
								maxSize: MAX_SIZE,
								retention: RETENTION,
								path: ROTATED_SUBDIR,
							},
						},
					},
					env: {},
				});

				const { httpURL, dataRootDir } = ctx.harper;
				const client = createApiClient(ctx.harper);
				const auth = client.headers.Authorization;

				const mainLogDir = (ctx.harper as any).logDir ?? join(dataRootDir, 'log');
				const mainLogPath = join(mainLogDir, 'hdb.log');
				const rotatedDir = join(dataRootDir, ROTATED_SUBDIR);

				// Readiness poll: hit the probe route directly until it stops 404-ing (component
				// pre-installed by setupHarperWithFixture; no restart needed).
				{
					const deadline = Date.now() + 120_000;
					let ready = false;
					while (Date.now() < deadline) {
						try {
							const r = await fetch(`${httpURL}/Bump/`, {
								method: 'POST',
								headers: { 'Content-Type': 'application/json', 'Authorization': auth },
								body: '{}',
								signal: AbortSignal.timeout(3_000),
							});
							if (r.status !== 404) {
								await r.text().catch(() => {});
								ready = true;
								break;
							}
						} catch {
							/* not ready yet */
						}
						await sleep(250);
					}
					ok(ready, 'Bump route did not become ready within 120 seconds');
				}

				// ASSERT the config was actually accepted (not a false positive from a bad key name).
				const cfg = await client.req().send({ operation: 'get_configuration' }).expect(200);
				strictEqual(
					cfg.body?.logging?.rotation?.maxSize,
					MAX_SIZE,
					'get_configuration must echo back the configured maxSize'
				);
				strictEqual(
					cfg.body?.logging?.rotation?.enabled,
					true,
					'get_configuration must echo back rotation.enabled=true'
				);
				strictEqual(cfg.body?.logging?.rotation?.retention, RETENTION, 'get_configuration must echo back retention');
				console.log(
					`[QA-686 Q1/Q2] config accepted: maxSize=${cfg.body.logging.rotation.maxSize} ` +
						`retention=${cfg.body.logging.rotation.retention} enabled=${cfg.body.logging.rotation.enabled}`
				);

				// Sustained load: continuous concurrent writers for > 1 audit tick (60s).
				let requestsCompleted = 0;
				let stop = false;
				async function loadWorker() {
					while (!stop) {
						try {
							const r = await fetch(`${httpURL}/Bump/`, {
								method: 'POST',
								headers: { 'Content-Type': 'application/json', 'Authorization': auth },
								body: '{}',
								signal: AbortSignal.timeout(5_000),
							});
							if (r.ok) requestsCompleted++;
							await r.text().catch(() => {});
						} catch {
							/* transient errors don't stop the sustained-load probe */
						}
					}
				}

				let peakActiveSize = 0;
				async function sampler() {
					while (!stop) {
						const size = fileSize(mainLogPath);
						if (size > peakActiveSize) peakActiveSize = size;
						await sleep(POLL_INTERVAL_MS);
					}
				}

				const CONCURRENCY = 8;
				const workers = Array.from({ length: CONCURRENCY }, loadWorker);
				const samplerPromise = sampler();
				await sleep(LOAD_DURATION_MS);
				stop = true;
				await Promise.race([Promise.all(workers), sleep(5_000)]);
				await samplerPromise;

				// Let buffered writes settle before the final read.
				await sleep(2_000);
				const finalActiveSize = fileSize(mainLogPath);
				const rotated = rotatedFiles(rotatedDir);
				const totalRotatedBytes = rotated.reduce((sum, f) => sum + Math.max(f.size, 0), 0);
				const totalOnDisk = Math.max(finalActiveSize, 0) + totalRotatedBytes;

				// Non-blind oracle: a hard LOWER BOUND on bytes actually written, independent of
				// whatever timestamp/level/thread-id prefix the logger framework adds (prefixes only
				// make lines BIGGER, never smaller than the padding we control).
				const bytesGeneratedMin = requestsCompleted * LINES_PER_REQUEST * PADDING_LEN;

				console.log(
					`\n[QA-686 Q1/Q2] configuredMaxSize=${MAX_SIZE} (${MAX_BYTES}B) requestsCompleted=${requestsCompleted}\n` +
						`  bytesGeneratedMin=${bytesGeneratedMin}B (>= configured maxSize by ${(bytesGeneratedMin / MAX_BYTES).toFixed(1)}x)\n` +
						`  peakActiveSize=${peakActiveSize}B (overshoot=${(peakActiveSize / MAX_BYTES).toFixed(2)}x maxSize)\n` +
						`  finalActiveSize=${finalActiveSize}B rotatedCount=${rotated.length} ` +
						`rotatedSizes=${JSON.stringify(rotated.map((r) => r.size))}\n` +
						`  totalOnDisk(active+rotated)=${totalOnDisk}B ratio-to-bytesGenerated=${(totalOnDisk / Math.max(bytesGeneratedMin, 1)).toFixed(2)}x`
				);

				// Oracle proof: we definitely generated well past the configured maxSize.
				ok(
					bytesGeneratedMin > MAX_BYTES * 5,
					`must have generated far more than configured maxSize before checking rotation: ` +
						`generated=${bytesGeneratedMin}B configured=${MAX_BYTES}B`
				);
				// With a 64KB ceiling and >75s of continuous multi-worker writes, at least one
				// rotation must have occurred (rotation is enabled and maxSize is correctly parsed).
				ok(rotated.length >= 1, `expected at least one rotation to have occurred; rotatedCount=${rotated.length}`);
			}
		);
	}
);
