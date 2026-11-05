/**
 * A client certificate's CRL verdict is cached in `system.hdb_certificate_cache` for `crl.cacheTtl`. The table is
 * sourced from the verifier (`security/certificateVerification/crlVerification.ts`, `getCertificateCacheTable`
 * -> `sourcedFrom(CertificateVerificationSource)`); the source stores each verdict with
 * `expiresAt = now + cacheTtl` (`certificateVerificationSource.ts`, `CertificateVerificationSource.get`), and a
 * later `get` on a row past its `expiresAt` re-fetches from the source (`resources/Table.ts`
 * `ensureLoadedFromSource`, the `needsSourceData` expiry clause), which re-runs the verification and rewrites
 * the row. The suite's `crl-verification.test.ts` runs with a 7-day TTL, so it never crosses that boundary.
 * This file does, with an 8 s TTL and the served CRL flipped under a cached `good` verdict, across a
 * `threads.count: 0` restart with no write in between (the verdict row is then past its expiry but still
 * stored: no cleanup scan has run).
 *
 *   R1 valid cert                                       -> 200; verdict row `good`, expiresAt = R1 + TTL
 *   restart, no write
 *   R2 valid cert, past the TTL after R1                -> 200; the expired row is rewritten (checked_at moves)
 *   flip the served CRL to also list the valid serial
 *   R3 valid cert, before the R2 verdict's expiresAt     -> 200 from the cached verdict (checked_at unchanged)
 *   R4 valid cert, past the TTL after R2                -> 401; verdict rewritten to `revoked`, revoked row stored
 *   R5 revoked cert                                     -> 401 (control)
 *
 * R3 and R4 are the same request against the same flipped CRL and differ only in whether the verdict's TTL has
 * elapsed, so together they pin both halves of the contract: a verdict is honoured inside its TTL and refreshed
 * after it (with a TTL longer than the run, R4 is accepted with the verdict unchanged, so the 401 comes from the
 * expiry, not from re-verifying every request). `unitTests/resources/certificateVerificationTables.test.js`
 * pins the stored `expiresAt` window and the refill after expiry at the table level; what only this file pins
 * is the honoured-inside-TTL half (R3), the 401 through a real handshake, and the stored-but-expired row
 * surviving a restart.
 *
 * `hdb_crl_cache` stores no row on this build (#2832), so every verdict refresh downloads the served CRL; R1
 * asserts that premise so that, once a CRL is cached, this test says why R4 changed instead of failing on a
 * status (it will then need a CRL whose next_update falls inside the TTL window).
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/crl-verdict-cache-expiry.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import * as https from 'node:https';
import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import {
	generateCrlCertificates,
	startCrlServer,
	stopCrlServer,
	type CrlCertificates,
	type CrlServerContext,
} from '../utils/securityServices.ts';

const HTTPS_PORT = 9927;
const FIXTURE_PATH = join(import.meta.dirname, 'system-table-probe');
// long enough that R3 lands before the R2 verdict expires on a slow shard, short enough to cross twice in one run
const CACHE_TTL_MS = 8000;
const PAST_TTL_MARGIN_MS = 1500;
const CERT_CACHE = 'hdb_certificate_cache';
const CRL_CACHE = 'hdb_crl_cache';
const REVOKED = 'hdb_revoked_certificates';
const ALL_REVOKED_CRL = 'test-all.crl';

interface StoredRow {
	id: string;
	expiresAt: number;
	record: Record<string, any>;
}
interface Verdict {
	status: number;
	at: number;
}

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

suite(
	'CRL verdict cache: honoured inside cacheTtl, refreshed after it, across a restart with no write',
	{ skip: skipSuite, concurrency: 1, timeout: 300_000 },
	(ctx: ContextWithHarper) => {
		let crlServer: CrlServerContext | null = null;
		let certsPath: string;
		let certs: CrlCertificates;
		let config: Record<string, unknown>;
		const verdicts: Record<string, Verdict> = {};
		const rows: Record<string, StoredRow | undefined> = {};
		const authHeaders = () => ({
			'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			'Content-Type': 'application/json',
		});

		/** As setupCrlServerWithCerts, plus a second CRL that also lists the valid client's serial. */
		async function startCrlServerWithCerts(): Promise<CrlServerContext> {
			const maxRetries = 5;
			for (let attempt = 0; attempt < maxRetries; attempt++) {
				const port = 50000 + Math.floor(Math.random() * 10000);
				try {
					certs = await generateCrlCertificates(certsPath, '127.0.0.1', port, undefined, { [ALL_REVOKED_CRL]: [2, 3] });
					return await startCrlServer(certsPath, port, certs);
				} catch (error: any) {
					if (error.code === 'EADDRINUSE' && attempt < maxRetries - 1) continue;
					throw new Error(`Failed to start the CRL server after ${attempt + 1} attempts: ${error.message}`);
				}
			}
			throw new Error('unreachable');
		}

		/** One full TLS handshake per call (no keep-alive, no session cache), so each request is verified afresh; the
		 * mTLS user is `admin`, so an accepted handshake answers the probe route with 200 and a rejected one 401. */
		async function request(client: { cert: string; key: string }): Promise<Verdict> {
			const deadline = Date.now() + 30_000;
			for (;;) {
				try {
					return await new Promise<Verdict>((resolveVerdict, reject) => {
						const agent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
						const req = https.request(
							`https://${ctx.harper.hostname}:${HTTPS_PORT}/SystemTableProbe/?table=${CERT_CACHE}`,
							{
								agent,
								cert: readFileSync(client.cert),
								key: readFileSync(client.key),
								ca: readFileSync(certs.ca),
								rejectUnauthorized: false, // Harper serves a self-signed certificate
								headers: { Connection: 'close' },
								timeout: 30_000,
							},
							(res) => {
								res.resume();
								res.on('end', () => {
									agent.destroy();
									resolveVerdict({ status: res.statusCode!, at: Date.now() });
								});
							}
						);
						req.on('timeout', () => req.destroy(new Error('request timed out')));
						req.on('error', (err) => {
							agent.destroy();
							reject(err);
						});
						req.end();
					});
				} catch (error: any) {
					// only a listener that is not up yet is retried; any HTTP status is a verdict
					if (error.code === 'ECONNREFUSED' && Date.now() < deadline) {
						await sleep(250);
						continue;
					}
					throw error;
				}
			}
		}

		async function stored(table: string): Promise<StoredRow[]> {
			const r = await fetch(`${ctx.harper.httpURL}/SystemTableProbe/?table=${table}`, { headers: authHeaders() });
			const text = await r.text();
			strictEqual(r.status, 200, `probe ${table} -> ${r.status}: ${text}`);
			return JSON.parse(text);
		}
		const verdictRows = (all: StoredRow[]) => all.filter((r) => r.id.startsWith('crl:'));

		async function operation(body: Record<string, unknown>): Promise<any> {
			const r = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: authHeaders(),
				body: JSON.stringify(body),
			});
			const text = await r.text();
			strictEqual(r.status, 200, `${body.operation} -> ${r.status}: ${text}`);
			return JSON.parse(text);
		}

		function certificateLogLines(): string[] {
			const path = join(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'), 'hdb.log');
			if (!existsSync(path)) return [`<${path} missing>`];
			return readFileSync(path, 'utf8')
				.split('\n')
				.filter((l) => /crl|certificate/i.test(l));
		}
		const accepted = (v: Verdict) => v.status === 200;
		const sec = (ms: number) => Math.round(ms) / 1000;
		const log = (label: string, value: unknown) => console.log(`[crl-verdict-cache] ${label} ${JSON.stringify(value)}`);

		async function waitPastTtl(reference: Verdict) {
			const wait = reference.at + CACHE_TTL_MS + PAST_TTL_MARGIN_MS - Date.now();
			if (wait > 0) await sleep(wait);
		}

		before(async () => {
			certsPath = await mkdtemp(join(tmpdir(), 'harper-crl-verdict-cache-'));
			crlServer = await startCrlServerWithCerts();
			config = {
				threads: { count: 0 },
				http: {
					mtls: {
						user: 'admin',
						certificateVerification: {
							failureMode: 'fail-closed',
							crl: { enabled: true, timeout: 30000, cacheTtl: CACHE_TTL_MS },
							ocsp: { enabled: false },
						},
					},
				},
				tls: { certificateAuthority: certs.ca },
			};
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config });
		});

		after(async () => {
			if (crlServer) await stopCrlServer(crlServer);
			await teardownHarper(ctx);
			if (certsPath) await rm(certsPath, { recursive: true, force: true, maxRetries: 3 });
		});

		test('R1: a valid certificate is accepted and its good verdict is stored with expiresAt = now + cacheTtl', async () => {
			strictEqual((await operation({ operation: 'get_configuration' })).threads.count, 0);
			const t0 = Date.now();
			verdicts.R1 = await request(certs.valid);
			const verdict = verdictRows(await stored(CERT_CACHE));
			rows.R1 = verdict[0];
			const crlRows = await stored(CRL_CACHE);
			log('R1', { status: verdicts.R1.status, verdict, crlRows, revokedRows: await stored(REVOKED) });
			ok(
				accepted(verdicts.R1),
				`R1: valid certificate must be accepted (200 from the probe route), got ${verdicts.R1.status}`
			);
			strictEqual(verdict.length, 1, `one crl: verdict row expected, got ${JSON.stringify(verdict)}`);
			strictEqual(verdict[0].record.status, 'good');
			strictEqual(
				crlRows.length,
				0,
				'premise: hdb_crl_cache stores no row on this build (#2832), so every verdict refresh downloads the served CRL; once it caches one, R4 reads that CRL and this test needs one whose next_update falls inside the TTL window'
			);
			ok(
				verdict[0].expiresAt >= t0 + CACHE_TTL_MS - 500 && verdict[0].expiresAt <= verdicts.R1.at + CACHE_TTL_MS,
				`verdict expiresAt ${verdict[0].expiresAt} is not ~ R1 + ${CACHE_TTL_MS} ms (R1 window ${t0}..${verdicts.R1.at})`
			);
		});

		test('restart with no write', async () => {
			await killHarper(ctx);
			await startHarper(ctx, { config });
			// readiness is read through the operations API so nothing writes to the verification tables
			const deadline = Date.now() + 120_000;
			for (;;) {
				try {
					await operation({ operation: 'describe_all' });
					break;
				} catch (error) {
					if (Date.now() > deadline) throw error;
					await sleep(250);
				}
			}
			strictEqual(
				(await operation({ operation: 'get_configuration' })).threads.count,
				0,
				'threads.count must still be 0'
			);
		});

		test('R2: past the TTL, the valid certificate is accepted and the expired verdict row is rewritten', async () => {
			await waitPastTtl(verdicts.R1);
			const before = verdictRows(await stored(CERT_CACHE));
			verdicts.R2 = await request(certs.valid);
			const verdict = verdictRows(await stored(CERT_CACHE));
			rows.R2 = verdict[0];
			log('R2', { status: verdicts.R2.status, secondsSinceR1: sec(verdicts.R2.at - verdicts.R1.at), before, verdict });
			ok(
				before.length === 1 && before[0].expiresAt < verdicts.R2.at - PAST_TTL_MARGIN_MS,
				'premise: the R1 verdict row is stored and past its expiry'
			);
			ok(
				accepted(verdicts.R2),
				`R2: valid certificate must be accepted (200 from the probe route), got ${verdicts.R2.status}`
			);
			strictEqual(verdict.length, 1);
			ok(
				verdict[0].record.checked_at > rows.R1!.record.checked_at,
				`verdict checked_at did not move: R1 ${rows.R1!.record.checked_at}, R2 ${verdict[0].record.checked_at}`
			);
			ok(verdict[0].expiresAt > rows.R1!.expiresAt, 'verdict expiresAt did not move');
		});

		test('R3: with the served CRL flipped, the valid certificate is still accepted from the cached verdict inside the TTL', async () => {
			copyFileSync(certs.extraCrls![ALL_REVOKED_CRL], certs.crl);
			verdicts.R3 = await request(certs.valid);
			const verdict = verdictRows(await stored(CERT_CACHE));
			log('R3', { status: verdicts.R3.status, secondsSinceR2: sec(verdicts.R3.at - verdicts.R2.at), verdict });
			ok(
				verdicts.R3.at < rows.R2!.expiresAt,
				`R3 landed at ${verdicts.R3.at}, past the R2 verdict's expiresAt ${rows.R2!.expiresAt} (${sec(verdicts.R3.at - verdicts.R2.at)} s after R2): not inside the TTL`
			);
			ok(
				accepted(verdicts.R3),
				`R3: the cached verdict must be honoured (200 from the probe route), got ${verdicts.R3.status}`
			);
			strictEqual(
				verdict[0].record.checked_at,
				rows.R2!.record.checked_at,
				'R3 re-verified the certificate (checked_at moved) instead of honouring the cached verdict'
			);
		});

		test('R4: past the TTL, the valid certificate (now listed in the served CRL) is rejected and the verdict is rewritten', async () => {
			await waitPastTtl(verdicts.R2);
			const before = verdictRows(await stored(CERT_CACHE));
			verdicts.R4 = await request(certs.valid);
			const verdict = verdictRows(await stored(CERT_CACHE));
			const revokedRows = await stored(REVOKED);
			log('R4', {
				status: verdicts.R4.status,
				secondsSinceR2: sec(verdicts.R4.at - verdicts.R2.at),
				before,
				verdict,
				revokedRows,
			});
			if (verdicts.R4.status !== 401) log('R4 hdb.log /crl|certificate/i', certificateLogLines().slice(0, 200));
			strictEqual(
				verdicts.R4.status,
				401,
				`R4: expected 401 once the stored good verdict is past its expiry, got ${verdicts.R4.status}`
			);
			strictEqual(verdict[0]?.record.status, 'revoked');
			ok(
				revokedRows.some((r) => /^0?2$/.test(r.record.serial_number)),
				`no hdb_revoked_certificates row for serial 2: ${JSON.stringify(revokedRows)}`
			);
		});

		test('R5: the revoked certificate is rejected (control)', async () => {
			verdicts.R5 = await request(certs.revoked);
			log('R5', { status: verdicts.R5.status });
			strictEqual(verdicts.R5.status, 401, `R5: revoked certificate must get 401, got ${verdicts.R5.status}`);
		});
	}
);
