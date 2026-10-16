/**
 * TLS Array Configuration on First-Boot Install.
 *
 * When `tls` (or `operationsApi.tls`) is configured as the documented SNI array
 * form (`tls: [{ certificate, privateKey, ... }, ...]`), first-boot installation
 * previously called `updateConfigCert()` (`security/keys.ts`) which unconditionally
 * scheduled flat `tls_privateKey` writes into the `YAMLSeq` node and logged
 * `Error: Expected a valid index, not privateKey.` at `[error]` level to `hdb.log`.
 *
 * Scope:
 *   - A1 is the primary regression test for `updateConfigCert()` on first-boot install.
 *   - A2–A6 and B1 guard adjacent array/object TLS invariants (config file preservation,
 *     `system.hdb_certificate` population, SNI selection, `set_configuration`, and restart).
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/tls-array-install.test.ts"
 */

import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import * as yaml from 'yaml';
import {
	teardownHarper,
	startHarper,
	killHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import * as pkijs from 'pkijs';
import {
	generateEd25519KeyPair,
	createCertificate,
	makeExtKeyUsageExt,
	certToPem,
} from '../utils/security/certGenUtils.ts';

const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1';
const SUBJECT_ALT_NAME_OID = '2.5.29.17';
const TLS_HANDSHAKE_TIMEOUT_MS = 5000;

function makeSubjectAltNameExt(hostname: string): pkijs.Extension {
	const altNames = new pkijs.GeneralNames({
		names: [new pkijs.GeneralName({ type: 2, value: hostname })],
	});
	return new pkijs.Extension({
		extnID: SUBJECT_ALT_NAME_OID,
		critical: false,
		extnValue: altNames.toSchema().toBER(),
	});
}

interface TlsEntry {
	name?: string;
	hostname?: string;
	certificate: string;
	privateKey: string;
	certificateAuthority?: string;
}

function getLogPath(ctx: ContextWithHarper): string {
	const logDir = ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log');
	return join(logDir, 'hdb.log');
}

function getLogContent(ctx: ContextWithHarper): string {
	return readFileSync(getLogPath(ctx), 'utf8');
}

function getPhaseLogContent(ctx: ContextWithHarper, logBefore: string): string {
	const currentLog = getLogContent(ctx);
	// Slice to only lines appended during this phase when the prior log prefix is intact;
	// fall back to the full current log if the file was truncated or rotated.
	if (logBefore.length > 0 && currentLog.startsWith(logBefore)) {
		return currentLog.slice(logBefore.length);
	}
	return currentLog;
}

function getConfigPath(ctx: ContextWithHarper): string {
	const harperConfig = join(ctx.harper.dataRootDir, 'harper-config.yaml');
	return existsSync(harperConfig) ? harperConfig : join(ctx.harper.dataRootDir, 'harperdb-config.yaml');
}

function getErrorLines(log: string): string[] {
	return log.split('\n').filter((line) => line.includes('[error]'));
}

function getPeerCertCN(host: string, port: number, servername: string, caPem: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = tls.connect(
			{
				host,
				port,
				servername,
				ca: caPem,
				rejectUnauthorized: true,
				timeout: TLS_HANDSHAKE_TIMEOUT_MS,
			},
			() => {
				const peerCert = socket.getPeerCertificate();
				socket.end();
				const cn = peerCert?.subject?.CN;
				if (typeof cn === 'string') {
					resolve(cn);
				} else if (Array.isArray(cn) && cn.length > 0) {
					resolve(cn[0]);
				} else {
					reject(new Error(`Missing peer certificate CN for ${servername} on port ${port}`));
				}
			}
		);
		socket.on('timeout', () => {
			socket.destroy();
			reject(
				new Error(`TLS handshake timed out after ${TLS_HANDSHAKE_TIMEOUT_MS}ms for ${servername} on ${host}:${port}`)
			);
		});
		socket.on('error', (err) => {
			socket.destroy();
			reject(err);
		});
	});
}

suite('TLS array configuration on first-boot install', () => {
	let certDir: string;
	let caPem: string;
	let caPath: string;
	let entryA: TlsEntry;
	let entryB: TlsEntry;
	let entryC: TlsEntry;

	before(async () => {
		certDir = mkdtempSync(join(tmpdir(), 'harper-tls-array-certs-'));

		const caSubject = { CN: 'Harper TLS Array Test Root CA' };
		const caKeys = await generateEd25519KeyPair();
		const caCert = await createCertificate({
			serialNumber: 1,
			subject: caSubject,
			issuer: caSubject,
			validDays: 30,
			issuerKey: caKeys.privateKey,
			subjectPublicKey: caKeys.publicKey,
			isCA: true,
		});
		caPem = certToPem(caCert);
		caPath = join(certDir, 'ca.pem');
		writeFileSync(caPath, caPem);

		async function createHostCert(hostname: string, serialNumber: number, includeCA: boolean): Promise<TlsEntry> {
			const keys = await generateEd25519KeyPair();
			const cert = await createCertificate({
				serialNumber,
				subject: { CN: hostname },
				issuer: caSubject,
				validDays: 30,
				issuerKey: caKeys.privateKey,
				subjectPublicKey: keys.publicKey,
				isCA: false,
				extensions: [makeSubjectAltNameExt(hostname), makeExtKeyUsageExt([SERVER_AUTH_OID])],
			});
			const certPath = join(certDir, `${hostname}.crt`);
			const keyPath = join(certDir, `${hostname}.key`);
			writeFileSync(certPath, certToPem(cert));
			writeFileSync(keyPath, keys.privateKeyPem);
			const entry: TlsEntry = {
				name: hostname,
				hostname,
				certificate: certPath,
				privateKey: keyPath,
			};
			if (includeCA) {
				entry.certificateAuthority = caPath;
			}
			return entry;
		}

		entryA = await createHostCert('host-a.harper.local', 2, true);
		entryB = await createHostCert('host-b.harper.local', 3, false);
		entryC = await createHostCert('host-c.harper.local', 4, false);
	});

	after(() => {
		if (certDir) {
			rmSync(certDir, { recursive: true, force: true });
		}
	});

	suite('A: first-boot install with two-entry tls array', (ctx: ContextWithHarper) => {
		let installLog = '';

		before(async () => {
			await startHarper(ctx, {
				config: {
					operationsApi: {
						network: {
							securePort: 9935,
						},
					},
					tls: [entryA, entryB],
				},
			});
			installLog = getLogContent(ctx);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('A1: first-boot install with array tls logs zero [error] lines in hdb.log', () => {
			assert.ok(installLog.length > 0, 'Expected hdb.log to be non-empty after first-boot install');
			assert.ok(
				installLog.includes('Harper installation was successful.') &&
					installLog.includes('Harper successfully started.'),
				'Expected hdb.log to contain startup and install log entries'
			);
			assert.equal(
				installLog.includes('Expected a valid index, not privateKey'),
				false,
				`Expected no 'Expected a valid index, not privateKey' error in first-boot hdb.log, got:\n${installLog}`
			);
			const errorLines = getErrorLines(installLog);
			assert.deepEqual(
				errorLines,
				[],
				`Expected zero [error] lines in first-boot install hdb.log, found:\n${errorLines.join('\n')}`
			);
		});

		// A2–A6 guard adjacent array-TLS invariants across config persistence, certificate table
		// population, SNI certificate selection, set_configuration updates, and restart.
		test('A2: harper-config.yaml retains the 2-entry tls array without default privateKey injection', () => {
			const configFile = getConfigPath(ctx);
			const parsed = yaml.parse(readFileSync(configFile, 'utf8'));
			assert.ok(Array.isArray(parsed.tls), 'Expected parsed.tls in config file to be an array');
			assert.equal(parsed.tls.length, 2);
			assert.deepEqual(parsed.tls[0], entryA);
			assert.deepEqual(parsed.tls[1], entryB);
			for (const item of parsed.tls) {
				assert.ok(
					!String(item.privateKey).endsWith('keys/privateKey.pem'),
					'Expected array tls entry not to have default keys/privateKey.pem injected'
				);
			}
		});

		test('A3: system.hdb_certificate contains rows for both array entries, the CA, and self-signed certs', async () => {
			const rows = (await sendOperation(ctx.harper, {
				operation: 'search_by_value',
				database: 'system',
				table: 'hdb_certificate',
				search_attribute: 'name',
				search_value: '*',
				get_attributes: ['*'],
			})) as Array<{
				name: string;
				hostnames?: string[];
				is_authority: boolean;
				is_self_signed?: boolean | null;
				details?: {
					subject?: string;
					subject_alt_name?: string;
				};
			}>;
			assert.ok(Array.isArray(rows));

			const hostARow = rows.find((r) => r.name === 'host-a.harper.local' && !r.is_authority && !r.is_self_signed);
			assert.ok(hostARow, `Expected serving row for host-a.harper.local in ${JSON.stringify(rows)}`);
			assert.equal(hostARow.details?.subject, 'CN=host-a.harper.local');
			assert.deepEqual(hostARow.hostnames, ['host-a.harper.local']);

			const hostBRow = rows.find((r) => r.name === 'host-b.harper.local' && !r.is_authority && !r.is_self_signed);
			assert.ok(hostBRow, `Expected serving row for host-b.harper.local in ${JSON.stringify(rows)}`);
			assert.equal(hostBRow.details?.subject, 'CN=host-b.harper.local');
			assert.deepEqual(hostBRow.hostnames, ['host-b.harper.local']);

			const caRow = rows.find(
				(r) => r.name === 'Harper TLS Array Test Root CA' && r.is_authority === true && !r.is_self_signed
			);
			assert.ok(caRow, `Expected configured CA row (is_authority: true) in ${JSON.stringify(rows)}`);

			const selfSignedCert = rows.find((r) => r.is_self_signed === true && r.is_authority === false);
			assert.ok(selfSignedCert, `Expected self-signed serving cert row in ${JSON.stringify(rows)}`);

			const selfSignedCA = rows.find((r) => r.is_self_signed === true && r.is_authority === true);
			assert.ok(selfSignedCA, `Expected self-signed CA row in ${JSON.stringify(rows)}`);
		});

		test('A4: HTTPS (9927) and operationsApi securePort (9935) serve each configured host certificate by SNI', async () => {
			const host = ctx.harper.hostname;
			assert.equal(await getPeerCertCN(host, 9927, 'host-a.harper.local', caPem), 'host-a.harper.local');
			assert.equal(await getPeerCertCN(host, 9927, 'host-b.harper.local', caPem), 'host-b.harper.local');
			assert.equal(await getPeerCertCN(host, 9935, 'host-a.harper.local', caPem), 'host-a.harper.local');
			assert.equal(await getPeerCertCN(host, 9935, 'host-b.harper.local', caPem), 'host-b.harper.local');
		});

		test('A5: set_configuration with a 3-entry tls array persists without logging errors', async () => {
			const logBefore = getLogContent(ctx);
			const threeEntries = [entryA, entryB, entryC];
			await sendOperation(ctx.harper, {
				operation: 'set_configuration',
				tls: threeEntries,
			});

			const getRes = await sendOperation(ctx.harper, {
				operation: 'get_configuration',
			});
			assert.deepEqual(getRes.tls, threeEntries);

			const configFile = getConfigPath(ctx);
			const parsed = yaml.parse(readFileSync(configFile, 'utf8'));
			assert.deepEqual(parsed.tls, threeEntries);

			const phaseLog = getPhaseLogContent(ctx, logBefore);
			assert.equal(
				phaseLog.includes('Expected a valid index, not'),
				false,
				`Expected no YAMLSeq setIn error during set_configuration, got:\n${phaseLog}`
			);
			const errorLines = getErrorLines(phaseLog);
			assert.deepEqual(
				errorLines,
				[],
				`Expected zero [error] lines during set_configuration, found:\n${errorLines.join('\n')}`
			);
		});

		test('A6: restart after set_configuration boots with zero [error] lines and serves the 3rd host by SNI', async () => {
			const logBeforeRestart = getLogContent(ctx);
			await killHarper(ctx);
			await startHarper(ctx, {
				config: {
					operationsApi: {
						network: {
							securePort: 9935,
						},
					},
				},
			});

			const restartLog = getPhaseLogContent(ctx, logBeforeRestart);
			assert.equal(
				restartLog.includes('Expected a valid index, not'),
				false,
				`Expected no YAMLSeq setIn error during restart, got:\n${restartLog}`
			);
			const errorLines = getErrorLines(restartLog);
			assert.deepEqual(errorLines, [], `Expected zero [error] lines during restart, found:\n${errorLines.join('\n')}`);

			const host = ctx.harper.hostname;
			assert.equal(await getPeerCertCN(host, 9927, 'host-c.harper.local', caPem), 'host-c.harper.local');
			assert.equal(await getPeerCertCN(host, 9935, 'host-c.harper.local', caPem), 'host-c.harper.local');
		});
	});

	suite('B: control — first-boot install with single tls object', (ctx: ContextWithHarper) => {
		let controlInstallLog = '';

		before(async () => {
			await startHarper(ctx, {
				config: {
					operationsApi: {
						network: {
							securePort: 9935,
						},
					},
					tls: {
						certificate: entryA.certificate,
						privateKey: entryA.privateKey,
						certificateAuthority: entryA.certificateAuthority,
					},
				},
			});
			controlInstallLog = getLogContent(ctx);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('B1: first-boot install with object tls logs zero [error] lines, keeps tls as an object, and serves certificate', async () => {
			assert.ok(controlInstallLog.length > 0, 'Expected hdb.log to be non-empty after control install');
			assert.ok(
				controlInstallLog.includes('Harper installation was successful.') &&
					controlInstallLog.includes('Harper successfully started.'),
				'Expected hdb.log to contain startup and install log entries'
			);
			assert.equal(
				controlInstallLog.includes('Expected a valid index, not'),
				false,
				`Expected no YAMLSeq setIn error in control install hdb.log, got:\n${controlInstallLog}`
			);
			const errorLines = getErrorLines(controlInstallLog);
			assert.deepEqual(
				errorLines,
				[],
				`Expected zero [error] lines in control install hdb.log, found:\n${errorLines.join('\n')}`
			);

			const configFile = getConfigPath(ctx);
			const parsed = yaml.parse(readFileSync(configFile, 'utf8'));
			assert.equal(Array.isArray(parsed.tls), false, 'Expected parsed.tls in config file to be an object');
			assert.equal(typeof parsed.tls, 'object');
			assert.equal(parsed.tls.certificate, entryA.certificate);
			assert.equal(parsed.tls.privateKey, entryA.privateKey);
			assert.equal(parsed.tls.certificateAuthority, entryA.certificateAuthority);

			const host = ctx.harper.hostname;
			assert.equal(await getPeerCertCN(host, 9927, 'host-a.harper.local', caPem), 'host-a.harper.local');
			assert.equal(await getPeerCertCN(host, 9935, 'host-a.harper.local', caPem), 'host-a.harper.local');
		});
	});
});
