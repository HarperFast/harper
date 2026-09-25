/**
 * The three tables certificate verification caches into, on a node's own boot: its workers must load each
 * with its table-level expiration whether or not the node ever verifies a certificate, including over the
 * tables and rows a release from before this change left.
 *
 * The pre-release suite needs HARPER_LEGACY_530_PRERELEASE_PATH (dist/bin/harper.js of harper@5.3.0-beta.2)
 * and is skipped without it. CI sets it everywhere but the uWS HTTP job: that registry install has no
 * uWebSockets.js, so under HARPER_UWS_HTTP the legacy binary's workers cannot bind.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as https from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
import { setupCrlServerWithCerts, stopCrlServer, type CrlServerContext } from '../utils/securityServices.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, 'certificate-verification-tables');
const LEGACY_PRERELEASE_BIN_PATH = process.env.HARPER_LEGACY_530_PRERELEASE_PATH;
const HTTPS_PORT = 9927;

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

const UNINDEXED = { indexed: false, expiresAt: false };
const INDEXED = { indexed: true, expiresAt: false };
const DECLARED = {
	hdb_certificate_cache: {
		expiration: 3_600,
		durable: { status: UNINDEXED, reason: UNINDEXED, checked_at: UNINDEXED, method: UNINDEXED },
	},
	hdb_crl_cache: {
		expiration: 86_400,
		durable: {
			issuer_dn: UNINDEXED,
			crl_blob: UNINDEXED,
			this_update: UNINDEXED,
			next_update: UNINDEXED,
			signature_valid: UNINDEXED,
		},
	},
	hdb_revoked_certificates: {
		expiration: 691_200,
		durable: {
			serial_number: INDEXED,
			issuer_key_id: INDEXED,
			revocation_date: UNINDEXED,
			revocation_reason: UNINDEXED,
			crl_source: INDEXED,
			crl_next_update: UNINDEXED,
		},
	},
};
type TableName = keyof typeof DECLARED;
const TABLE_NAMES = Object.keys(DECLARED) as TableName[];

interface TableState {
	expiration: number | null;
	durableExpiration: number | null;
	durable: Record<string, { indexed: boolean; expiresAt: boolean }>;
	rows: { id: string; expiresAt: number | null; fields: string[] }[];
}
type State = Record<TableName, TableState | null>;

function tablesSuite(ctx: ContextWithHarper) {
	let client: ReturnType<typeof createApiClient>;

	async function readState(): Promise<State> {
		const response = await fetch(`${ctx.harper.httpURL}/CertificateVerificationTables/`, {
			headers: { Authorization: client.headers.Authorization },
		});
		strictEqual(response.status, 200, `/CertificateVerificationTables/ should return 200, got ${response.status}`);
		return (await response.json()) as State;
	}

	async function boot(start: () => Promise<unknown>): Promise<void> {
		await start();
		client = createApiClient(ctx.harper);
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			try {
				await readState();
				return;
			} catch {
				/* not up yet */
			}
			await sleep(250);
		}
		throw new Error('/CertificateVerificationTables/ never returned 200 within 60s of the boot');
	}

	function assertDeclared(state: State) {
		for (const name of TABLE_NAMES) {
			const table = state[name];
			ok(table, `system.${name} exists`);
			deepStrictEqual(table.durable, DECLARED[name].durable, `__dbis__ declares system.${name} in full`);
			strictEqual(table.durableExpiration, DECLARED[name].expiration, `__dbis__ stores system.${name}'s expiration`);
			strictEqual(table.expiration, DECLARED[name].expiration, `the worker loaded system.${name}'s expiration`);
		}
	}

	return { readState, boot, assertDeclared };
}

suite('certificate verification tables on a fresh install', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	const { readState, boot, assertDeclared } = tablesSuite(ctx);

	before(async () => {
		await boot(() =>
			setupHarperWithFixture(ctx, FIXTURE_PATH, { config: { logging: { console: true, level: 'error' } }, env: {} })
		);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('are declared in full before any certificate is verified', async () => {
		assertDeclared(await readState());
	});
});

suite(
	'certificate verification tables left by a pre-change release are repaired at boot',
	{ skip: skipSuite || !LEGACY_PRERELEASE_BIN_PATH || !existsSync(LEGACY_PRERELEASE_BIN_PATH) },
	(ctx: ContextWithHarper) => {
		const { readState, boot, assertDeclared } = tablesSuite(ctx);
		let crlServer: CrlServerContext;
		let certsPath: string;
		// Re-passed verbatim on every startHarper call: omitting it on a restart wipes config.
		let bootConfig: Record<string, unknown>;
		let revocationExpiries: Record<string, number | null>;

		function mtlsStatus(which: 'valid' | 'revoked'): Promise<number> {
			return new Promise<number>((resolveStatus, reject) => {
				const req = https.request(
					`https://${ctx.harper.hostname}:${HTTPS_PORT}/`,
					{
						cert: readFileSync(crlServer.certs[which].cert),
						key: readFileSync(crlServer.certs[which].key),
						ca: readFileSync(crlServer.certs.ca),
						rejectUnauthorized: false,
					},
					(res) => {
						res.resume();
						res.on('end', () => resolveStatus(res.statusCode!));
					}
				);
				req.on('error', (err: any) => reject(new Error(`Request failed: ${err.code || err.message}`)));
				req.end();
			});
		}

		async function assertVerifies() {
			strictEqual(await mtlsStatus('revoked'), 401, 'the revoked certificate is refused');
			ok((await mtlsStatus('valid')) !== 401, 'the valid certificate is accepted');
		}

		before(async () => {
			certsPath = await mkdtemp(join(tmpdir(), 'harper-cert-tables-'));
			crlServer = await setupCrlServerWithCerts(certsPath);
			bootConfig = {
				logging: { console: true, level: 'error' },
				http: {
					mtls: {
						user: 'admin',
						certificateVerification: {
							failureMode: 'fail-closed',
							crl: { enabled: true, timeout: 30000 },
							ocsp: { enabled: false },
						},
					},
				},
				tls: { certificateAuthority: crlServer.certs.ca },
			};
			await boot(() =>
				setupHarperWithFixture(ctx, FIXTURE_PATH, {
					config: bootConfig,
					env: {},
					harperBinPath: LEGACY_PRERELEASE_BIN_PATH,
				})
			);
		});

		after(async () => {
			await stopCrlServer(crlServer);
			await teardownHarper(ctx);
			await rm(certsPath, { recursive: true, force: true, maxRetries: 3 });
		});

		test('the pre-change release declares them with @expiresAt and caches verdicts with no stored expiry', async () => {
			await assertVerifies();
			let state: State;
			const deadline = Date.now() + 10_000;
			do {
				state = await readState();
				if ((state.hdb_certificate_cache?.rows.length ?? 0) >= 2) break;
				await sleep(100);
			} while (Date.now() < deadline);
			strictEqual(state.hdb_certificate_cache!.durable.expiresAt?.expiresAt, true);
			strictEqual(state.hdb_revoked_certificates!.durable.expiresAt?.expiresAt, true);
			strictEqual(state.hdb_certificate_cache!.durableExpiration, null);
			ok(state.hdb_certificate_cache!.rows.length >= 2, 'both verdicts were cached');
			for (const verdict of state.hdb_certificate_cache!.rows) {
				strictEqual(verdict.expiresAt, null, `verdict ${verdict.id} has no stored expiry`);
				ok(verdict.fields.includes('expiresAt'), 'its expiry was a field');
			}
			const revocations = state.hdb_revoked_certificates!.rows;
			ok(revocations.length >= 1, 'the revocation was stored');
			for (const revocation of revocations) ok(revocation.expiresAt! > Date.now(), 'with a stored expiry');
			revocationExpiries = Object.fromEntries(revocations.map(({ id, expiresAt }) => [id, expiresAt]));
		});

		test('a read-only boot of this build leaves them as they are', async () => {
			await killHarper(ctx);
			await boot(() => startHarper(ctx, { config: bootConfig, env: { HARPER_READONLY: '1' } }));
			const state = await readState();
			strictEqual(state.hdb_certificate_cache!.durable.expiresAt?.expiresAt, true);
			strictEqual(state.hdb_certificate_cache!.durableExpiration, null);
		});

		test('the next writable boot declares them in full, keeping each revocation and dropping the verdicts', async () => {
			await killHarper(ctx);
			await boot(() => startHarper(ctx, { config: bootConfig, env: {} }));
			const state = await readState();
			assertDeclared(state);
			deepStrictEqual(
				Object.fromEntries(state.hdb_revoked_certificates!.rows.map(({ id, expiresAt }) => [id, expiresAt])),
				revocationExpiries,
				'every revocation keeps the expiry it was stored with'
			);
			deepStrictEqual(state.hdb_certificate_cache!.rows, [], 'the verdicts stored with no expiry are evicted');

			await assertVerifies();
		});
	}
);
