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
		socket.on('error', (err) => {
			socket.destroy();
			reject(err);
		});
	});
}

suite('TLS array configuration on first-boot install and runtime update', () => {
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
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('A1: first-boot install with array tls logs zero [error] lines in hdb.log', () => {
			const log = getLogContent(ctx);
			assert.ok(log.length > 0, 'Expected hdb.log to be non-empty');
			assert.ok(
				log.includes('Harper installation was successful.') && log.includes('Harper successfully started.'),
				'Expected hdb.log to contain startup and install log entries'
			);
			assert.equal(
				log.includes('Expected a valid index, not privateKey'),
				false,
				`Expected no 'Expected a valid index, not privateKey' error in hdb.log, got:\n${log}`
			);
			const errorLines = getErrorLines(log);
			assert.deepEqual(errorLines, [], `Expected zero [error] lines in hdb.log, found:\n${errorLines.join('\n')}`);
		});

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

			const errorLines = getErrorLines(getLogContent(ctx).slice(logBefore.length));
			assert.deepEqual(
				errorLines,
				[],
				`Expected zero [error] lines during set_configuration, found:\n${errorLines.join('\n')}`
			);
		});

		test('A6: restart after set_configuration boots with zero [error] lines and serves the 3rd host by SNI', async () => {
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

			const errorLines = getErrorLines(getLogContent(ctx));
			assert.deepEqual(errorLines, [], `Expected zero [error] lines after restart, found:\n${errorLines.join('\n')}`);

			const host = ctx.harper.hostname;
			assert.equal(await getPeerCertCN(host, 9927, 'host-c.harper.local', caPem), 'host-c.harper.local');
			assert.equal(await getPeerCertCN(host, 9935, 'host-c.harper.local', caPem), 'host-c.harper.local');
		});
	});

	suite('B: control — first-boot install with single tls object', (ctx: ContextWithHarper) => {
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
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('B1: first-boot install with object tls logs zero [error] lines, keeps tls as an object, and serves certificate', async () => {
			const log = getLogContent(ctx);
			assert.ok(log.length > 0, 'Expected hdb.log to be non-empty');
			assert.ok(
				log.includes('Harper installation was successful.') && log.includes('Harper successfully started.'),
				'Expected hdb.log to contain startup and install log entries'
			);
			const errorLines = getErrorLines(log);
			assert.deepEqual(errorLines, [], `Expected zero [error] lines in hdb.log, found:\n${errorLines.join('\n')}`);

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
