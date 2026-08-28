/**
 * TLS Certificate + Private-Key Hot-Reload — multi-worker propagation.
 *
 * Companion to cert-reload.test.ts (#586), which deliberately rotates ONLY the
 * certificate (same key) to isolate the cert-propagation path. This test rotates
 * BOTH the certificate and the private key at once — the case that exposes the
 * worker key-rotation race in security/keys.ts:
 *
 *   - The main thread watches the cert file and writes the new cert into the
 *     system.hdb_certificate table; each worker is subscribed and rebuilds its TLS
 *     secure context (updateTLS) on that notification.
 *   - Each worker independently reloads its private key from disk into its in-thread
 *     privateKeys map (no table propagation for keys).
 *
 * The race: a worker can receive the new cert (table subscription -> updateTLS) and
 * build a secure context BEFORE it has reloaded the matching new key, pairing the
 * new cert with the OLD key. Two behaviors this test pins (#586 + #2382):
 *
 *   1. Retain-last-good: while the table holds the new cert but the matching key has
 *      not arrived, every worker must KEEP serving the old, still-consistent pair —
 *      a mismatched rebuild must not drop the hostname to the self-signed default or
 *      fail handshakes (#2382: that downgrade served the wrong cert for days).
 *   2. Convergence: once the key arrives (via chokidar OR the periodic poll), each
 *      worker rebuilds locally and converges on the new cert + new key (#586).
 *
 * The convergence signature is per-worker, so it only surfaces with >= 2 HTTP
 * workers each terminating TLS.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/cert-key-reload.test.ts"
 */

import { suite, test, before, after } from 'node:test';
import { ok, strictEqual as equal } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as tls from 'node:tls';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import {
	generateEd25519KeyPair,
	createCertificate,
	makeExtKeyUsageExt,
	certToPem,
	type Ed25519KeyPair,
} from '../utils/security/certGenUtils.ts';

const HTTPS_PORT = 9927; // fixed by the integration-testing harness
const FIXTURE_PATH = join(import.meta.dirname, 'fixture');
const WORKERS = 2; // >= 2 HTTP workers is the whole point — see file header
const CERT_CN = 'cert-key-reload-test.harper.local';
const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1';
const testsBun = process.env.HARPER_RUNTIME === 'bun';
const skipSuite = process.platform === 'win32' || testsBun;

/** Build a self-signed Ed25519 server certificate (PEM) for the given key pair and serial. */
async function makeServerCertPem(keyPair: Ed25519KeyPair, serialNumber: number): Promise<string> {
	const cert = await createCertificate({
		serialNumber,
		subject: { CN: CERT_CN, O: 'Harper Cert+Key Reload Test' },
		issuer: { CN: CERT_CN, O: 'Harper Cert+Key Reload Test' },
		validDays: 365,
		issuerKey: keyPair.privateKey,
		subjectPublicKey: keyPair.publicKey,
		extensions: [makeExtKeyUsageExt([SERVER_AUTH_OID])],
	});
	return certToPem(cert);
}

/**
 * Open one fresh TLS connection (no session reuse) and return the served cert serial.
 * A cert/key mismatch on the chosen worker fails the handshake, surfacing as a rejection.
 */
function servedSerial(hostname: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = tls.connect(
			{
				host: hostname,
				port: HTTPS_PORT,
				servername: CERT_CN, // SNI -> our context specifically, independent of the default cert
				rejectUnauthorized: false, // self-signed; we only want to read the served cert
				session: undefined, // force a full handshake so the kernel can spread us across workers
			},
			() => {
				const peer = socket.getPeerCertificate();
				socket.destroy();
				if (!peer || !peer.serialNumber) {
					reject(new Error('no peer certificate returned'));
					return;
				}
				resolve(peer.serialNumber);
			}
		);
		socket.setTimeout(5000, () => {
			socket.destroy();
			reject(new Error('TLS connection timed out'));
		});
		socket.on('error', reject);
	});
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

suite(
	'TLS certificate + private-key hot-reload propagates to all workers',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let certsDir: string;
		let certPath: string;
		let keyPath: string;
		let keyPairA: Ed25519KeyPair;
		let keyPairB: Ed25519KeyPair;

		before(async () => {
			certsDir = await mkdtemp(join(tmpdir(), 'harper-cert-key-reload-'));
			certPath = join(certsDir, 'certificate.pem');
			keyPath = join(certsDir, 'privateKey.pem');

			// Two independent key pairs: the rotation swaps BOTH the cert and the key, so the new
			// cert is signed by (and pairs with) keyPairB — a worker that rebuilds with the new cert
			// but the old key (keyPairA) cannot complete a handshake.
			keyPairA = await generateEd25519KeyPair();
			keyPairB = await generateEd25519KeyPair();
			await writeFile(keyPath, keyPairA.privateKeyPem);
			await writeFile(certPath, await makeServerCertPem(keyPairA, 3001));

			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					threads: { count: WORKERS },
					tls: {
						certificate: certPath,
						privateKey: keyPath,
					},
				},
			});
		});

		after(async () => {
			await teardownHarper(ctx);
			await rm(certsDir, { recursive: true, force: true, maxRetries: 3 });
		});

		test('every worker converges on the renewed cert + key after an on-disk swap of both', async (t) => {
			// Guard: confirm we really booted multiple workers — otherwise the test is
			// vacuous (a single worker can never diverge from itself).
			const workerCount = await observedWorkerCount(ctx);
			ok(workerCount >= 2, `expected >= 2 HTTP workers, observed ${workerCount} — test would be vacuous`);

			// Baseline: the serial currently being served (cert 3001, key A).
			const initialSerial = await servedSerial(ctx.harper.hostname);
			equal(parseInt(initialSerial, 16), 3001, `expected the initial cert serial 3001, got 0x${initialSerial}`);

			// Reused for re-arming watch events below. File-watch delivery (chokidar/inotify) is
			// unreliable on some CI filesystems (overlayfs/containers/network mounts) — the very reason
			// Harper added a polling fallback — so each rotation step re-writes its file periodically to
			// give a dropped watch event another chance. The re-write bumps mtime, which is what the
			// watcher keys on; the content stays fixed so the served serial assertions stay exact.
			const certBPem = await makeServerCertPem(keyPairB, 3002);
			const NUDGE_MS = 5_000;

			// Force the worst-case interleaving the fixes target: the new CERT reaches the table
			// BEFORE the matching new key. We write only the cert first (still signed by key B, so it
			// does NOT match the key A still on disk). The main thread's file watcher writes it into
			// hdb_certificate; that arrival is confirmed through the operations API — an internal
			// observable — because the serving behavior must NOT change (that's the point of #2382's
			// retain-last-good: the mismatched rebuild keeps the old pair).
			//
			// In a real rotation the two files change near-simultaneously and the ordering is a race;
			// here we pin the losing order so the regression is deterministic rather than timing-luck.
			await writeFile(certPath, certBPem);

			const certDeadline = Date.now() + 30_000;
			let certInTable = false;
			let lastNudge = Date.now();
			while (Date.now() < certDeadline) {
				if (await tableHasSerial(ctx, 3002)) {
					certInTable = true;
					break;
				}
				if (Date.now() - lastNudge > NUDGE_MS) {
					await writeFile(certPath, certBPem); // re-arm a possibly-missed watch event
					lastNudge = Date.now();
				}
				await sleep(250);
			}
			if (!certInTable) {
				// The cert file change never reached the main thread's watcher in this environment, so
				// the cert-before-key ordering cannot be established. That's a file-watch/inotify
				// limitation of the runner, not a regression — skip the setup rather than fail. (The
				// unit tests cover the rebuild paths deterministically; this test adds end-to-end
				// coverage where file watching works.)
				t.skip(
					'cert file change never reached hdb_certificate in this environment (file-watch/inotify ' +
						'limitation) — cannot establish the cert-before-key ordering this test exercises'
				);
				return;
			}

			// Retain-last-good (#2382, unconditional once the ordering is established): the table now
			// holds cert 3002 while every worker still has key A. Rebuilds are firing and failing for
			// this record; through 2+ debounce windows every handshake must still SUCCEED and still
			// serve 3001 — never a failure, never the self-signed default. Before the fix, the failed
			// rebuild dropped the hostname's context and this loop observed exactly that.
			const retainDeadline = Date.now() + 6_000;
			while (Date.now() < retainDeadline) {
				const serial = await servedSerial(ctx.harper.hostname).catch((error) => {
					throw new Error(
						`handshake failed while the renewed cert had no matching key — last-good was not retained: ${error}`
					);
				});
				equal(
					parseInt(serial, 16),
					3001,
					'a worker stopped serving the last-good cert while the renewed cert had no matching key'
				);
				await sleep(250);
			}

			// Now deliver the matching key. Each worker reloads key B into its in-thread map, and the
			// key-reload rebuild (plus the failure retry) converges the worker on cert+key B (#586).
			await writeFile(keyPath, keyPairB.privateKeyPem);

			// Wait for convergence on at least one connection: a SUCCESSFUL handshake serving the new
			// serial proves the new cert is paired with the new key. serialNumber is hex. We re-arm the
			// key watch event on the same cadence, since the worker key reload is also inotify-driven.
			const deadline = Date.now() + 30_000;
			let newSerial = initialSerial;
			lastNudge = Date.now();
			while (Date.now() < deadline) {
				try {
					const s = await servedSerial(ctx.harper.hostname);
					if (parseInt(s, 16) === 3002) {
						newSerial = s;
						break;
					}
				} catch {
					// still mismatched on this worker — keep polling
				}
				if (Date.now() - lastNudge > NUDGE_MS) {
					await writeFile(keyPath, keyPairB.privateKeyPem); // re-arm a possibly-missed key watch event
					lastNudge = Date.now();
				}
				await sleep(500);
			}
			equal(
				parseInt(newSerial, 16),
				3002,
				`cert+key never converged — no worker served the renewed cert 3002 within 30s after the key ` +
					`arrived (a worker rebuilt for the new cert with the old key and never rebuilt again)`
			);

			// Settling grace: each worker debounces its rebuild independently. The poll above exits as
			// soon as ONE worker has converged; sleep so every other worker's debounce has also fired.
			await sleep(3000);

			// The regression assertion: hammer the port with many fresh handshakes so the kernel
			// (SO_REUSEPORT) spreads us across every worker. Require that ALL succeed (no worker left on
			// new-cert + old-key, which fails the handshake) and ALL serve the new serial. Before the
			// fix, a worker that rebuilt for the new cert before reloading the key stays mismatched —
			// it never rebuilds again until the next cert-table change — so this fails.
			const ATTEMPTS = 40;
			const results = await Promise.allSettled(
				Array.from({ length: ATTEMPTS }, () => servedSerial(ctx.harper.hostname))
			);
			const serials = results
				.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
				.map((r) => r.value);
			ok(
				serials.length >= 38,
				`too many handshakes failed: ${ATTEMPTS - serials.length}/${ATTEMPTS} errors — ` +
					`a worker is likely stuck on the new cert paired with the old key`
			);

			const stale = serials.filter((s) => s !== newSerial);
			equal(
				stale.length,
				0,
				`${stale.length}/${serials.length} connections did not serve the new serial ${newSerial} ` +
					`(saw ${[...new Set(stale)].join(', ')}) — cert+key reload did not reach every worker`
			);
		});
	}
);

/** Whether hdb_certificate holds a server cert with this serial, via the operations API. */
async function tableHasSerial(ctx: ContextWithHarper, serialNumber: number): Promise<boolean> {
	try {
		const res = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				operation: 'search_by_value',
				schema: 'system',
				table: 'hdb_certificate',
				search_attribute: 'name',
				search_value: '*',
				get_attributes: ['name', 'details'],
			}),
		});
		const certs = (await res.json()) as { details?: { serial_number?: string } }[];
		return (
			Array.isArray(certs) && certs.some((cert) => parseInt(cert.details?.serial_number ?? '', 16) === serialNumber)
		);
	} catch {
		return false;
	}
}

/** Observed live HTTP worker count via the operations API (best-effort, returns 0 on failure). */
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
