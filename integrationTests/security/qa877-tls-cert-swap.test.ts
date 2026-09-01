/**
 * QA-877 — anchor for the cert-table object-swap gap described in #2004, and the narrowing of
 * which triggers can actually reach it.
 *
 * #2004: `createTLSSelector`'s `updateTLS()` (security/keys.ts) binds its `hdb_certificate`
 * subscription to a specific table OBJECT. Paths that replace `databases.system.hdb_certificate`
 * with a NEW object — `resetDatabases()` (copy_db, ITC restart handling) and the LMDB→RocksDB
 * engine migration — orphan that subscription. #1999 made `updateTLS()` detect the swap
 * (`subscribedTable !== databases.system.hdb_certificate`) and re-subscribe, but that comparison
 * only runs when something re-enters `updateTLS()`. After a swap the only re-entry triggers are the
 * now-orphaned subscription (dead — bound to the OLD object), the zero-certs retry timer (armed
 * only when the last pass resolved empty, the #1998 path), and a private-key hot reload. So a swap
 * while `secureContexts` is NON-EMPTY would leave no pending trigger and the selector would keep
 * serving stale contexts.
 *
 * WHAT THIS FILE PINS
 *
 * The invariant asserted here is that an ordinary, ops-API-reachable schema change does NOT reach
 * that precondition: `create_attribute` on an unrelated table fans a schema broadcast out to every
 * worker and each runs `resetDatabases()`, yet a cert rotation performed immediately afterwards
 * still propagates to every worker, with zero stale certificates across 30 fresh handshakes per
 * thread count. The reason is in resources/databases.ts: the reconciliation loop `resetDatabases()`
 * re-runs (`getDatabases()` → `initStores()`) mutates the EXISTING Table wrapper in place unless
 * the storage ENGINE changed for that database, and an attribute add never flips that. This
 * narrows #2004's own phrasing for this ITC path — the schema broadcast alone is not sufficient;
 * something must additionally force a table recreate.
 *
 * If this file ever goes red on the "rotation after a schema change" leg, an ordinary schema change
 * has started forcing a real table-object swap, which makes #2004 reachable from a far more common
 * trigger than currently understood. That is an escalation, not a flake.
 *
 * The broadcast itself is not asserted from here — `create_attribute`'s own success is the
 * confirmation the schema change landed, and that the broadcast is what drives `resetDatabases()`
 * on every worker is established by resources/databases.ts and unitTests/security/keys.test.js.
 *
 * A rotation with no schema change in between is included as an in-suite control (it must keep
 * working for the schema-change leg to mean anything), and both legs run at `threads: 1` and
 * `threads: 4` because the #586-class failure signature is per-worker divergence, invisible to a
 * single-worker run.
 *
 * PROOF BOUNDARY
 *
 * This file does NOT reproduce the "swap while secureContexts is non-empty" precondition, and no
 * safe in-process route to it was found. The other paths #2004 names are boot-time or out of band:
 * the LMDB→RocksDB migration runs in `migrateOnStart()` before the HTTP listeners exist, so in any
 * one process's lifetime the first `updateTLS()` pass necessarily populates FROM the post-migration
 * table rather than being swapped out from under an already-populated one (and a worker-only
 * restart hands the new thread a fresh `createTLSSelector()` closure with empty contexts too); the
 * CLI `harper copydb system <path>` would mean a second process opening the same live store files,
 * which is not something a test should do to a running instance. Forcing the swap in-process from a
 * jsResource is also not available: the component loader confines a component's module resolution
 * to its own installed directory, and that boundary is a deliberate security control.
 *
 * Prior art, not restated here:
 *   - integrationTests/security/cert-reload.test.ts (#586) — plain on-disk renewal, no swap, must
 *     reach every worker.
 *   - integrationTests/security/cert-key-reload.test.ts — cert+key race, orthogonal to this bug.
 *   - unitTests/security/keys.test.js ("createTLSSelector when the hdb_certificate table object is
 *     swapped out") — whitebox proof that the #1999 fix works once SOMETHING re-enters
 *     `updateTLS()`; it manufactures that re-entry through the OLD table, which is precisely the
 *     gap #2004 flags as uncovered.
 *
 * Reproduction:
 *   npm run build && npm run test:integration -- "integrationTests/security/qa877-tls-cert-swap.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual as equal } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import * as tls from 'node:tls';

import {
	setupHarperWithFixture,
	teardownHarper,
	killHarper,
	startHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import {
	generateEd25519KeyPair,
	createCertificate,
	makeExtKeyUsageExt,
	certToPem,
	type Ed25519KeyPair,
} from '../utils/security/certGenUtils.ts';

const HTTPS_PORT = 9927; // fixed by the integration-testing harness (http.securePort)
const FIXTURE_PATH = join(import.meta.dirname, 'qa877-tls-cert-swap');
const CERT_CN = 'qa877-tls-cert-swap.harper.local';
const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1';
const testsBun = process.env.HARPER_RUNTIME === 'bun';
const skipSuite = process.platform === 'win32' || testsBun;

// Generous but bounded: normal reload settles well under 5s in practice (chokidar/poll + the
// 1500ms updateTLS debounce). 25s gives ample margin before we conclude "did not propagate".
const PROPAGATION_WAIT_MS = 25_000;
const FANOUT_ATTEMPTS = 30;
// Each worker debounces its own updateTLS() rebuild with a 1500ms timer. The schema-change leg
// asserts a NON-event (the served cert does not change), so it must wait clearly past that debounce
// — waiting exactly 1500ms would let a swap land just after the probe and read as "unchanged",
// which is the very failure the leg exists to catch.
const NON_EVENT_SETTLE_MS = 5_000;

async function makeServerCertPem(keyPair: Ed25519KeyPair, serialNumber: number): Promise<string> {
	const cert = await createCertificate({
		serialNumber,
		subject: { CN: CERT_CN, O: 'QA-877 TLS Cert Swap Test' },
		issuer: { CN: CERT_CN, O: 'QA-877 TLS Cert Swap Test' },
		validDays: 365,
		issuerKey: keyPair.privateKey,
		subjectPublicKey: keyPair.publicKey,
		extensions: [makeExtKeyUsageExt([SERVER_AUTH_OID])],
	});
	return certToPem(cert);
}

interface ServedCert {
	/** Decimal serial (Node reports serialNumber as hex; normalized once here via parseInt(.., 16)
	 * so every comparison downstream is a plain decimal `===`, avoiding hex-case footguns). */
	serial: number;
	fingerprint256: string;
	subjectCN?: string;
}

/** Open one fresh TLS connection (no session reuse) and return the served peer certificate. */
function servedCert(hostname: string): Promise<ServedCert> {
	return new Promise((resolve, reject) => {
		const socket = tls.connect(
			{
				host: hostname,
				port: HTTPS_PORT,
				servername: CERT_CN,
				rejectUnauthorized: false,
				session: undefined, // force a full handshake so the kernel can spread us across workers
			},
			() => {
				const peer = socket.getPeerCertificate();
				socket.destroy();
				if (!peer || !peer.serialNumber) {
					reject(new Error('no peer certificate returned'));
					return;
				}
				resolve({
					serial: parseInt(peer.serialNumber, 16),
					fingerprint256: peer.fingerprint256,
					subjectCN: (peer.subject as any)?.CN,
				});
			}
		);
		socket.setTimeout(5000, () => {
			socket.destroy();
			reject(new Error('TLS connection timed out'));
		});
		socket.on('error', reject);
	});
}

/** Fan out N fresh handshakes (SO_REUSEPORT spreads them across workers) and tabulate served serials. */
async function fanOut(hostname: string, attempts: number): Promise<{ serials: number[]; errors: number }> {
	const results = await Promise.allSettled(Array.from({ length: attempts }, () => servedCert(hostname)));
	const serials = results
		.filter((r): r is PromiseFulfilledResult<ServedCert> => r.status === 'fulfilled')
		.map((r) => r.value.serial);
	const errors = results.length - serials.length;
	return { serials, errors };
}

function tally(serials: number[]): string {
	const counts = new Map<number, number>();
	for (const s of serials) counts.set(s, (counts.get(s) ?? 0) + 1);
	return [...counts.entries()].map(([serial, n]) => `${serial}=${n}`).join(', ');
}

/**
 * Poll whole fan-outs until EVERY fresh handshake serves `expectedSerial`, or the deadline passes;
 * `tookMs` is -1 if it never converged. Waiting on the all-worker condition rather than on the
 * first worker to flip is what makes this safe under load: each worker debounces its own
 * updateTLS() rebuild independently, so a one-connection probe can succeed while another worker is
 * still on the old context, and an immediate all-workers assertion would then fail a rotation that
 * was merely mid-flight.
 */
async function waitForAllWorkers(
	hostname: string,
	expectedSerial: number,
	attempts: number,
	deadlineMs: number
): Promise<{ tookMs: number; serials: number[]; errors: number }> {
	const start = Date.now();
	const deadline = start + deadlineMs;
	let last = await fanOut(hostname, attempts);
	while (true) {
		if (last.errors === 0 && last.serials.length === attempts && last.serials.every((s) => s === expectedSerial)) {
			return { tookMs: Date.now() - start, ...last };
		}
		if (Date.now() >= deadline) return { tookMs: -1, ...last };
		await sleep(400);
		last = await fanOut(hostname, attempts);
	}
}

/** Observed live worker count via the operations API (best-effort, 0 on failure) — same guard as cert-reload.test.ts. */
async function observedWorkerCount(ctx: ContextWithHarper): Promise<number> {
	try {
		const res = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ operation: 'system_information', attributes: ['threads'] }),
		});
		const body = (await res.json()) as { threads?: unknown };
		return Array.isArray(body.threads) ? body.threads.length : 0;
	} catch {
		return 0;
	}
}

for (const WORKERS of [1, 4]) {
	suite(
		`QA-877 TLS cert-table swap vs rotation [threads=${WORKERS}] (#2004)`,
		{ skip: skipSuite },
		(ctx: ContextWithHarper) => {
			let certsDir: string;
			let certPath: string;
			let keyPath: string;
			let keyPair: Ed25519KeyPair;

			async function waitForReady() {
				const deadline = Date.now() + 120_000;
				while (Date.now() < deadline) {
					try {
						const res = await fetch(`${ctx.harper.httpURL}/Widget/`);
						// 404 means the route is not mounted yet; a 5xx means it is mounted but unhealthy,
						// which is also not ready — treating it as ready turns a fixture misconfiguration
						// into a cryptic TLS timeout further down.
						if (res.status !== 404 && res.status < 500) return;
					} catch {
						/* not ready yet */
					}
					await sleep(250);
				}
				throw new Error('Widget route never became ready');
			}

			before(async () => {
				certsDir = await mkdtemp(join(tmpdir(), 'qa877-tls-cert-swap-'));
				certPath = join(certsDir, 'certificate.pem');
				keyPath = join(certsDir, 'privateKey.pem');

				keyPair = await generateEd25519KeyPair();
				await writeFile(keyPath, keyPair.privateKeyPem);
				await writeFile(certPath, await makeServerCertPem(keyPair, 87701));

				await setupHarperWithFixture(ctx, FIXTURE_PATH, {
					config: {
						threads: { count: WORKERS },
						tls: { certificate: certPath, privateKey: keyPath },
					},
					// See cert-reload.test.ts: force the main-thread cert-file watcher to poll instead of
					// relying on inotify, which is unreliable on overlayfs/tmpfs-backed temp dirs.
					env: { CHOKIDAR_USEPOLLING: '1', CHOKIDAR_INTERVAL: '250' },
				});
				await waitForReady();
			});

			after(async () => {
				try {
					await teardownHarper(ctx);
				} finally {
					await rm(certsDir, { recursive: true, force: true, maxRetries: 3 });
				}
			});

			const SERIAL_BASELINE = 87701;
			const SERIAL_ROTATE_NO_SWAP = 87702; // control: rotation, no schema change involved
			const SERIAL_ROTATE_AFTER_SCHEMA_CHANGE = 87703; // rotation after an ordinary schema change

			test(`threads=${WORKERS}: baseline cert is served (peer cert inspected, not just "connected")`, async () => {
				// The harness hardcodes --THREADS_COUNT=1 and this suite overrides it via config. If
				// the override were ignored, or workers died during startup, every handshake below
				// would land on one survivor and the whole per-worker-divergence premise would be
				// silently vacuous.
				const workerCount = await observedWorkerCount(ctx);
				ok(
					workerCount >= WORKERS,
					`expected at least ${WORKERS} worker threads for this arm, observed ${workerCount} — the arm would be vacuous`
				);

				const { serials, errors } = await fanOut(ctx.harper.hostname, 10);
				equal(errors, 0, `unexpected handshake failures: ${errors}/10`);
				ok(
					serials.every((s) => s === SERIAL_BASELINE),
					`expected all connections to serve baseline serial ${SERIAL_BASELINE}, got: ${tally(serials)}`
				);
			});

			test(`threads=${WORKERS}: rotation with no schema change propagates normally (control, mirrors #586)`, async () => {
				await writeFile(certPath, await makeServerCertPem(keyPair, SERIAL_ROTATE_NO_SWAP));
				const { tookMs, serials, errors } = await waitForAllWorkers(
					ctx.harper.hostname,
					SERIAL_ROTATE_NO_SWAP,
					FANOUT_ATTEMPTS,
					PROPAGATION_WAIT_MS
				);
				console.log(`[QA-877 threads=${WORKERS}] rotation (no schema change) reached every worker in ${tookMs}ms`);
				equal(errors, 0, `unexpected handshake failures: ${errors}/${FANOUT_ATTEMPTS}`);
				ok(
					tookMs >= 0,
					`rotation did not reach every worker within ${PROPAGATION_WAIT_MS}ms, last tally: ${tally(serials)}`
				);
			});

			test(`threads=${WORKERS}: an ordinary schema change (create_attribute) triggers resetDatabases() but does not disturb the currently-served cert`, async () => {
				const attribute = `qa877SchemaChange_${WORKERS}`;
				await sendOperation(ctx.harper, {
					operation: 'create_attribute',
					schema: 'data',
					table: 'Widget',
					attribute,
				});
				// sendOperation already fails a non-200, but a 200 that did not actually alter the
				// schema would make the rest of this arm vacuous — so read the attribute back.
				const described = await sendOperation(ctx.harper, {
					operation: 'describe_table',
					database: 'data',
					table: 'Widget',
				});
				ok(
					(described?.attributes ?? []).some((a: { attribute?: string }) => a.attribute === attribute),
					`create_attribute reported success but '${attribute}' is not on the table: ${JSON.stringify(described?.attributes)}`
				);
				// A fixed wait is right here: the assertion below is that something did NOT happen
				// (the served cert did not change), so there is no condition to poll for.
				await sleep(NON_EVENT_SETTLE_MS);

				const { serials, errors } = await fanOut(ctx.harper.hostname, FANOUT_ATTEMPTS);
				equal(errors, 0, `unexpected handshake failures right after the schema change: ${errors}/${FANOUT_ATTEMPTS}`);
				ok(
					serials.every((s) => s === SERIAL_ROTATE_NO_SWAP),
					`expected ${SERIAL_ROTATE_NO_SWAP} unchanged, got: ${tally(serials)}`
				);
			});

			test(`threads=${WORKERS}: rotation AFTER that schema change ALSO propagates normally (#2004 does not reproduce via this trigger)`, async () => {
				await writeFile(certPath, await makeServerCertPem(keyPair, SERIAL_ROTATE_AFTER_SCHEMA_CHANGE));
				const { tookMs, serials, errors } = await waitForAllWorkers(
					ctx.harper.hostname,
					SERIAL_ROTATE_AFTER_SCHEMA_CHANGE,
					FANOUT_ATTEMPTS,
					PROPAGATION_WAIT_MS
				);
				const staleCount = serials.filter((s) => s === SERIAL_ROTATE_NO_SWAP).length;
				console.log(
					`[QA-877 threads=${WORKERS}] rotation after schema change: tookMs=${tookMs} errors=${errors} ` +
						`stale(${SERIAL_ROTATE_NO_SWAP})=${staleCount} tally=${tally(serials)}`
				);

				// A red assertion here means create_attribute's resetDatabases() call started forcing a
				// real table-object swap, which makes #2004 reachable from a far more common trigger
				// than currently understood. Escalate rather than adjust.
				equal(errors, 0, `unexpected handshake failures: ${errors}/${FANOUT_ATTEMPTS}`);
				ok(
					tookMs >= 0,
					`rotation after an ordinary schema change did not reach every worker within ` +
						`${PROPAGATION_WAIT_MS}ms, last tally: ${tally(serials)}`
				);
			});

			test(`threads=${WORKERS}: a restart serves whatever is currently on disk`, async () => {
				await killHarper(ctx);
				await startHarper(ctx, {
					config: {
						threads: { count: WORKERS },
						tls: { certificate: certPath, privateKey: keyPath },
					},
					env: { CHOKIDAR_USEPOLLING: '1', CHOKIDAR_INTERVAL: '250' },
				});
				await waitForReady();

				const { tookMs, serials, errors } = await waitForAllWorkers(
					ctx.harper.hostname,
					SERIAL_ROTATE_AFTER_SCHEMA_CHANGE,
					10,
					PROPAGATION_WAIT_MS
				);
				equal(errors, 0, `unexpected handshake failures after restart: ${errors}/10`);
				ok(
					tookMs >= 0,
					`expected the restart to serve the on-disk cert (${SERIAL_ROTATE_AFTER_SCHEMA_CHANGE}), got: ${tally(serials)}`
				);
			});
		}
	);
}
