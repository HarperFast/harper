/**
 * TLS Certificate Hot-Reload — multi-worker propagation (regression for #586).
 *
 * Issue #586: when the on-disk TLS server certificate is renewed/swapped while
 * Harper is running, the reload was observed (via Datadog synthetics) NOT to
 * reach every HTTP worker — some workers kept serving the OLD certificate while
 * others served the new one. The bug signature is per-thread divergence, so it
 * is invisible to a single-worker or unit test and only surfaces with >= 2
 * HTTP workers each terminating TLS.
 *
 * Propagation path under test (security/keys.ts):
 *   - Only the main thread watches the cert file (isMainThread guard) and writes
 *     the new cert into the system.hdb_certificate table on change.
 *   - Each worker subscribes to that table and rebuilds its own TLS secure
 *     context (updateTLS) on the notification.
 *   - SNICallback serves the rebuilt context live on every handshake.
 * The doubtful link is the table->worker subscription: this test proves the
 * swap reaches ALL workers, not just the one the next connection happens to hit.
 *
 * Strategy:
 *   1. Boot Harper with >= 2 HTTP workers and a self-signed server cert we own.
 *   2. Confirm the live worker count really is >= 2 (so we are not silently
 *      single-worker — the harness hardcodes --THREADS_COUNT=1, overridden here
 *      via HARPER_SET_CONFIG threads.count).
 *   3. Record the serial served before the swap.
 *   4. Overwrite the cert file on disk with a new cert (new serial, same key).
 *   5. Poll until the swap is observed, then open MANY short-lived TLS
 *      connections (load-balanced across workers via SO_REUSEPORT) and assert
 *      EVERY one serves the new serial — no worker is left on the old cert.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/cert-reload.test.ts"
 */

import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
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

const HTTPS_PORT = 9927;
const FIXTURE_PATH = join(import.meta.dirname, 'fixture');
const WORKERS = 2; // >= 2 HTTP workers is the whole point — see file header
const CERT_CN = 'cert-reload-test.harper.local';
const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1';
const testsBun = process.env.HARPER_RUNTIME === 'bun';
const skipSuite = process.platform === 'win32' || testsBun;

/** Build a self-signed Ed25519 server certificate (PEM) with the given serial. */
async function makeServerCertPem(keyPair: Ed25519KeyPair, serialNumber: number): Promise<string> {
	const cert = await createCertificate({
		serialNumber,
		subject: { CN: CERT_CN, O: 'Harper Cert Reload Test' },
		issuer: { CN: CERT_CN, O: 'Harper Cert Reload Test' },
		validDays: 365,
		issuerKey: keyPair.privateKey,
		subjectPublicKey: keyPair.publicKey,
		extensions: [makeExtKeyUsageExt([SERVER_AUTH_OID])],
	});
	return certToPem(cert);
}

/** Open one fresh TLS connection (no session reuse) and return the served cert serial. */
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

suite('TLS certificate hot-reload propagates to all workers (#586)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let certsDir: string;
	let certPath: string;
	let keyPath: string;
	let keyPair: Ed25519KeyPair;

	before(async () => {
		certsDir = await mkdtemp(join(tmpdir(), 'harper-cert-reload-'));
		certPath = join(certsDir, 'certificate.pem');
		keyPath = join(certsDir, 'privateKey.pem');

		// One key pair for the lifetime of the test; only the cert (its serial) changes
		// on renewal, which keeps the swap deterministic and isolates the cert-propagation
		// path (the actual #586 bug) from any private-key reload timing.
		keyPair = await generateEd25519KeyPair();
		await writeFile(keyPath, keyPair.privateKeyPem);
		await writeFile(certPath, await makeServerCertPem(keyPair, 1001));

		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: WORKERS },
				tls: {
					certificate: certPath,
					privateKey: keyPath,
				},
			},
			// Force the main-thread cert-file watcher (chokidar, in security/keys.ts) to poll the
			// file instead of relying on native fs.watch/inotify. The GitHub Actions Linux runners
			// back the temp dir with overlayfs/tmpfs, which silently DROPS inotify change events —
			// so the on-disk cert swap below was intermittently never detected and the reload never
			// fired, making this test time out ("cert never reloaded ... after 20s"). chokidar reads
			// CHOKIDAR_USEPOLLING / CHOKIDAR_INTERVAL as process-global overrides (honored by every
			// watcher in-process regardless of dependency depth), so this swaps detection to a stat
			// poll that is immune to the inotify drop. It only changes HOW the swap is detected — the
			// regression assertion (every worker serves the renewed cert) is unchanged, and the
			// product still uses native watching by default. The integration-testing harness merges
			// `env` into the spawned Harper process (harperLifecycle.js), so the override reaches the
			// main thread that owns the watcher. 250ms keeps detection well within the 20s budget.
			env: { CHOKIDAR_USEPOLLING: '1', CHOKIDAR_INTERVAL: '250' },
		});
	});

	after(async () => {
		await teardownHarper(ctx);
		await rm(certsDir, { recursive: true, force: true, maxRetries: 3 });
	});

	test('every worker serves the renewed certificate after an on-disk swap', async () => {
		// Guard: confirm we really booted multiple workers — otherwise the test is
		// vacuous (a single worker can never diverge from itself).
		const workerCount = await observedWorkerCount(ctx);
		ok(workerCount >= 2, `expected >= 2 HTTP workers, observed ${workerCount} — test would be vacuous`);

		// Baseline: the serial currently being served (cert 1001).
		const initialSerial = await servedSerial(ctx.harper.hostname);

		// Renew on disk: same key, new serial. mtime advances (boot took > 1s),
		// so the main-thread watcher treats the file as newer and writes it to
		// system.hdb_certificate, which each worker is subscribed to.
		await writeFile(certPath, await makeServerCertPem(keyPair, 2002));

		// Wait for the swap to become visible on at least one connection. The
		// subscription listener debounces ~1.5s, plus fs.watch latency.
		const deadline = Date.now() + 20_000;
		let newSerial = initialSerial;
		while (Date.now() < deadline) {
			newSerial = await servedSerial(ctx.harper.hostname);
			if (newSerial !== initialSerial) break;
			await sleep(500);
		}
		ok(newSerial !== initialSerial, `cert never reloaded — still serving ${initialSerial} after 20s`);

		// Settling grace period: each worker debounces updateTLS() independently with a
		// 1500ms setTimeout. The poll above exits as soon as one worker is observed to
		// have reloaded; sleeping here ensures the other worker's debounce has also fired
		// before we make the per-connection assertions.
		await sleep(2500);

		// The regression assertion: hammer the port with many fresh handshakes so
		// the kernel (SO_REUSEPORT) spreads us across every worker, and require
		// that NONE of them is still serving the old cert. Before #586's fix, a
		// subset of workers kept the stale serial and this would intermittently fail.
		const ATTEMPTS = 40;
		const results = await Promise.allSettled(Array.from({ length: ATTEMPTS }, () => servedSerial(ctx.harper.hostname)));
		const serials = results
			.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
			.map((r) => r.value);
		ok(serials.length >= 25, `too many handshakes failed: ${ATTEMPTS - serials.length}/${ATTEMPTS} errors`);

		const stale = serials.filter((s) => s === initialSerial);
		equal(
			stale.length,
			0,
			`${stale.length}/${serials.length} connections still served the OLD serial ${initialSerial} ` +
				`(expected all to serve ${newSerial}) — cert reload did not reach every worker`
		);
		const unexpected = serials.filter((s) => s !== newSerial);
		equal(unexpected.length, 0, `unexpected serials served: ${[...new Set(unexpected)].join(', ')}`);
	});
});

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
