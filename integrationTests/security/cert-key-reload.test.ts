/**
 * TLS renewal (#2978): rename-install both files in either order with polling disabled.
 * Incomplete pairs must stay unpublished; every worker must serve complete generations
 * without a self-signed fallback or a logged key mismatch.
 */

import { suite, test, before, after } from 'node:test';
import { ok, strictEqual as equal } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile, rename, readFile, unlink, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import {
	generateEd25519KeyPair,
	createCertificate,
	makeExtKeyUsageExt,
	certToPem,
	type Ed25519KeyPair,
} from '../utils/security/certGenUtils.ts';

const HTTPS_PORT = 9927;
const FIXTURE_PATH = join(import.meta.dirname, 'cert-key-reload-fixture');
const WORKERS = 2;
const CERT_CN = 'cert-key-reload-test.harper.local';
const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1';
const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

async function makeServerCertPem(keyPair: Ed25519KeyPair, serialNumber: number): Promise<string> {
	return certToPem(
		await createCertificate({
			serialNumber,
			subject: { CN: CERT_CN, O: 'Harper Cert+Key Reload Test' },
			issuer: { CN: CERT_CN, O: 'Harper Cert+Key Reload Test' },
			validDays: 365,
			issuerKey: keyPair.privateKey,
			subjectPublicKey: keyPair.publicKey,
			extensions: [makeExtKeyUsageExt([SERVER_AUTH_OID])],
		})
	);
}

function servedGeneration(hostname: string): Promise<{ serial: number; threadId: number }> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: hostname,
				port: HTTPS_PORT,
				path: '/Worker',
				servername: CERT_CN,
				rejectUnauthorized: false,
				agent: false,
			},
			(response) => {
				const serial = parseInt((response.socket as TLSSocket).getPeerCertificate().serialNumber, 16);
				let body = '';
				response.on('data', (chunk) => {
					body += chunk;
				});
				response.on('error', reject);
				response.on('end', () => {
					try {
						equal(response.statusCode, 200, body);
						resolve({ serial, threadId: JSON.parse(body).threadId });
					} catch (error) {
						reject(error);
					}
				});
			}
		);
		req.setTimeout(5000, () => req.destroy(new Error('TLS request timed out')));
		req.on('error', reject);
		req.end();
	});
}

async function renameInstall(filePath: string, pem: string) {
	const stagingPath = filePath + '.next';
	await writeFile(stagingPath, pem);
	await rename(stagingPath, filePath);
}

for (const readableKeyDirectory of [true, false])
	suite(
		`TLS certificate + private-key hot-reload propagates to all workers (${readableKeyDirectory ? 'readable' : 'traverse-only'} key directory)`,
		{ skip: skipSuite },
		(ctx: ContextWithHarper) => {
			let certsDir: string;
			let certPath: string;
			let keyPath: string;
			let currentSerial = 3001;
			let currentKeyPair: Ed25519KeyPair;

			before(async () => {
				certsDir = await mkdtemp(join(tmpdir(), 'harper-cert-key-reload-'));
				await mkdir(join(certsDir, 'keys'));
				certPath = join(certsDir, 'certificate.pem');
				keyPath = join(certsDir, 'keys', 'privateKey.pem');
				const initialKeyPair = (currentKeyPair = await generateEd25519KeyPair());
				await writeFile(keyPath, initialKeyPair.privateKeyPem);
				await writeFile(certPath, await makeServerCertPem(initialKeyPair, currentSerial));
				// The renewal writer needs write/execute access; the directory remains unreadable to the watcher.
				if (!readableKeyDirectory) await chmod(join(certsDir, 'keys'), 0o300);
				await setupHarperWithFixture(ctx, FIXTURE_PATH, {
					config: {
						threads: { count: WORKERS },
						logging: { file: true },
						tls: { certificate: certPath, privateKey: keyPath, certificateWatchInterval: 0 },
					},
				});
				equal(await observedWorkerCount(ctx), WORKERS);
				equal((await servedGeneration(ctx.harper.hostname)).serial, currentSerial);
			});

			after(async () => {
				await teardownHarper(ctx);
				await chmod(join(certsDir, 'keys'), 0o700);
				await rm(certsDir, { recursive: true, force: true, maxRetries: 3 });
			});

			function logPath() {
				return join(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'), 'hdb.log');
			}

			async function expectRenewal(nextSerial: number) {
				const deadline = Date.now() + 20000;
				const renewedWorkers = new Set<number>();
				while (Date.now() < deadline) {
					const generations = await Promise.all(
						Array.from({ length: 20 }, () => servedGeneration(ctx.harper.hostname))
					);
					for (const generation of generations) {
						ok([currentSerial, nextSerial].includes(generation.serial), `unexpected certificate ${generation.serial}`);
						ok(Number.isInteger(generation.threadId), 'missing worker identity');
						if (generation.serial === nextSerial) renewedWorkers.add(generation.threadId);
					}
					if (renewedWorkers.size === WORKERS && generations.every(({ serial }) => serial === nextSerial)) break;
					await delay(100);
				}
				equal(renewedWorkers.size, WORKERS, 'the renewed pair did not reach every worker');
				const finalGenerations = await Promise.all(
					Array.from({ length: 40 }, () => servedGeneration(ctx.harper.hostname))
				);
				ok(
					finalGenerations.every(({ serial }) => serial === nextSerial),
					'a worker still serves the old certificate'
				);
				ok(await tableHasSerial(ctx, nextSerial), 'the matching certificate was never published');
				const log = await readFile(logPath(), 'utf8');
				ok(!/key values mismatch|ERR_OSSL_X509_KEY_VALUES_MISMATCH/i.test(log), 'renewal logged a key values mismatch');
				currentSerial = nextSerial;
			}

			for (const first of ['certificate', 'private key']) {
				test(`rename-install ${first} first publishes only a matching pair and reaches every worker`, async () => {
					const logOffset = (await readFile(logPath(), 'utf8')).length;
					const nextSerial = currentSerial + 1;
					const keyPair = await generateEd25519KeyPair();
					const certPem = await makeServerCertPem(keyPair, nextSerial);
					const certFirst = first === 'certificate';
					await renameInstall(certFirst ? certPath : keyPath, certFirst ? certPem : keyPair.privateKeyPem);

					// Hold an incomplete pair across two rebuild windows to expose premature publication.
					const incompleteDeadline = Date.now() + 4500;
					while (Date.now() < incompleteDeadline) {
						equal(await tableHasSerial(ctx, nextSerial), false, 'an unmatched certificate was published');
						equal((await servedGeneration(ctx.harper.hostname)).serial, currentSerial);
						await delay(100);
					}

					const pendingLog = (await readFile(logPath(), 'utf8')).slice(logOffset);
					ok(
						pendingLog.includes('Waiting for matching TLS certificate and private key'),
						'the publisher never observed the incomplete pair'
					);
					await renameInstall(certFirst ? keyPath : certPath, certFirst ? keyPair.privateKeyPem : certPem);
					await expectRenewal(nextSerial);
					currentKeyPair = keyPair;
				});
			}
			if (!readableKeyDirectory) return;

			for (const removed of ['certificate', 'private key']) {
				test(`renewal survives deleting and recreating the ${removed} with polling disabled`, async () => {
					const nextSerial = currentSerial + 1;
					const keyPair = removed === 'certificate' ? currentKeyPair : await generateEd25519KeyPair();
					await unlink(removed === 'certificate' ? certPath : keyPath);
					// Exceed chokidar's 100ms atomic-write window so replacement emits add, not change.
					await delay(250);
					await writeFile(certPath, await makeServerCertPem(keyPair, nextSerial));
					if (removed === 'private key') await writeFile(keyPath, keyPair.privateKeyPem);
					await expectRenewal(nextSerial);
					currentKeyPair = keyPair;
				});
			}

			test('renewal follows an atomically replaced Secret-volume data symlink', async () => {
				const firstDir = join(certsDir, 'generation-a');
				const secondDir = join(certsDir, 'generation-b');
				await mkdir(firstDir);
				await mkdir(secondDir);
				const firstSerial = currentSerial + 1;
				await writeFile(join(firstDir, 'certificate.pem'), await makeServerCertPem(currentKeyPair, firstSerial));
				await writeFile(join(firstDir, 'privateKey.pem'), currentKeyPair.privateKeyPem);
				await symlink(firstDir, join(certsDir, '..data'));
				await unlink(certPath);
				await unlink(keyPath);
				await symlink('..data/certificate.pem', certPath);
				await symlink('../..data/privateKey.pem', keyPath);
				await expectRenewal(firstSerial);

				const nextSerial = currentSerial + 1;
				const keyPair = await generateEd25519KeyPair();
				await writeFile(join(secondDir, 'certificate.pem'), await makeServerCertPem(keyPair, nextSerial));
				await writeFile(join(secondDir, 'privateKey.pem'), keyPair.privateKeyPem);
				await symlink(secondDir, join(certsDir, '..data.next'));
				await rename(join(certsDir, '..data.next'), join(certsDir, '..data'));
				await rm(firstDir, { recursive: true });
				await expectRenewal(nextSerial);
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
