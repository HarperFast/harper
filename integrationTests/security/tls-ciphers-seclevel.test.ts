/**
 * TLS effective-cipher resolution — client CAs that need a relaxed OpenSSL security level.
 *
 * A client CA whose chain is SHA-1-signed only verifies when the listener's cipher string
 * carries `DEFAULT@SECLEVEL=0` (OpenSSL otherwise fails the chain with "CA signature digest
 * algorithm too weak", surfacing as authorizationError UNSPECIFIED on in-date certs). The
 * cipher string — and its @SECLEVEL — only takes effect at the listener level: a context
 * swapped in by the SNI callback does not carry its own cipher list onto the connection.
 * Harper previously applied only `tls.ciphers ?? tls[0].ciphers`, silently ignoring a
 * `ciphers` value on any other `tls[]` entry or certificate record, so mTLS deployments
 * that relaxed the level on the CA entry were rejected wholesale after every boot.
 *
 * This boots Harper with `tls` as an array whose SECOND entry is the SHA-1 client CA
 * carrying `ciphers: DEFAULT@SECLEVEL=0` (the previously-ignored position) and proves a
 * client certificate chained through that CA completes mTLS and authenticates.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/tls-ciphers-seclevel.test.ts"
 */

import { suite, test, before, after } from 'node:test';
import { ok, rejects } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as https from 'node:https';
import forge from 'node-forge';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const pki = forge.pki;
const HTTPS_PORT = 9927;
const FIXTURE_PATH = join(import.meta.dirname, 'fixture');
const RELAXED_CIPHERS = 'DEFAULT@SECLEVEL=0';
// Bun terminates TLS with BoringSSL, which has no @SECLEVEL concept — the listener cipher
// resolution under test is the Node path only.
const skipSuite = process.env.HARPER_RUNTIME === 'bun';

const DAY_MS = 24 * 60 * 60 * 1000;

interface PemChain {
	caPem: string;
	clientCertPem: string;
	clientKeyPem: string;
	serverCertPem: string;
	serverKeyPem: string;
	unchainedCertPem: string;
	unchainedKeyPem: string;
}

function makeCert(
	publicKey: forge.pki.rsa.PublicKey,
	subjectCn: string,
	issuerCn: string,
	serialNumber: string,
	extensions: any[]
) {
	const cert = pki.createCertificate();
	cert.publicKey = publicKey;
	cert.serialNumber = serialNumber;
	cert.validity.notBefore = new Date(Date.now() - DAY_MS);
	cert.validity.notAfter = new Date(Date.now() + 365 * DAY_MS);
	const subject = [{ name: 'commonName', value: subjectCn }];
	const issuer = [{ name: 'commonName', value: issuerCn }];
	cert.setSubject(subject);
	cert.setIssuer(issuer);
	cert.setExtensions(extensions);
	return cert;
}

/**
 * Build the incident-shaped PKI: an RSA CA and client certificate both signed with SHA-1
 * (the digest modern OpenSSL rejects above security level 0), plus an ordinary SHA-256
 * self-signed server certificate for the listener's own identity.
 */
function makeSha1ChainPems(): PemChain {
	const caKeys = pki.rsa.generateKeyPair(2048);
	const caCert = makeCert(caKeys.publicKey, 'SHA1 Test Client CA', 'SHA1 Test Client CA', '01', [
		{ name: 'basicConstraints', cA: true, critical: true },
		{ name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
	]);
	caCert.sign(caKeys.privateKey, forge.md.sha1.create());

	const clientKeys = pki.rsa.generateKeyPair(2048);
	const clientCert = makeCert(clientKeys.publicKey, 'sha1-mtls-client', 'SHA1 Test Client CA', '02', [
		{ name: 'basicConstraints', cA: false },
		{ name: 'extKeyUsage', clientAuth: true },
	]);
	clientCert.sign(caKeys.privateKey, forge.md.sha1.create());

	const serverKeys = pki.rsa.generateKeyPair(2048);
	const serverCert = makeCert(serverKeys.publicKey, 'localhost', 'localhost', '03', [
		{ name: 'basicConstraints', cA: false },
		{ name: 'extKeyUsage', serverAuth: true },
		{
			name: 'subjectAltName',
			altNames: [
				{ type: 2, value: 'localhost' },
				{ type: 7, ip: '127.0.0.1' },
			],
		},
	]);
	serverCert.sign(serverKeys.privateKey, forge.md.sha256.create());

	// control: a self-signed client cert that does NOT chain to the CA — must be rejected
	const unchainedKeys = pki.rsa.generateKeyPair(2048);
	const unchainedCert = makeCert(unchainedKeys.publicKey, 'unchained-client', 'unchained-client', '04', [
		{ name: 'basicConstraints', cA: false },
		{ name: 'extKeyUsage', clientAuth: true },
	]);
	unchainedCert.sign(unchainedKeys.privateKey, forge.md.sha256.create());

	return {
		caPem: pki.certificateToPem(caCert),
		clientCertPem: pki.certificateToPem(clientCert),
		clientKeyPem: pki.privateKeyToPem(clientKeys.privateKey),
		serverCertPem: pki.certificateToPem(serverCert),
		serverKeyPem: pki.privateKeyToPem(serverKeys.privateKey),
		unchainedCertPem: pki.certificateToPem(unchainedCert),
		unchainedKeyPem: pki.privateKeyToPem(unchainedKeys.privateKey),
	};
}

/** One HTTPS request; resolves with the status code (rejects on socket/handshake error). */
function requestStatus(hostname: string, clientCert?: { cert: string; key: string }): Promise<number> {
	return new Promise((resolve, reject) => {
		const request = https.request(
			`https://${hostname}:${HTTPS_PORT}/`,
			{
				...clientCert,
				// the client must also relax its own security level to present a SHA-1-signed cert
				ciphers: clientCert ? RELAXED_CIPHERS : undefined,
				rejectUnauthorized: false, // self-signed server cert; we only care about the client-cert side
				agent: false, // no keep-alive agent — each call is an independent handshake
			},
			(response) => {
				response.resume();
				response.on('end', () => resolve(response.statusCode ?? 0));
			}
		);
		request.setTimeout(10000, () => {
			request.destroy();
			reject(new Error('request timed out'));
		});
		request.on('error', reject);
		request.end();
	});
}

suite(
	'TLS listener honors SECLEVEL from a non-first tls entry (mTLS with SHA-1 client CA)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let certsDir: string;
		let chain: PemChain;

		before(async () => {
			certsDir = await mkdtemp(join(tmpdir(), 'harper-seclevel-test-'));
			chain = makeSha1ChainPems();
			const serverCertPath = join(certsDir, 'server-cert.pem');
			const serverKeyPath = join(certsDir, 'server-key.pem');
			const caPath = join(certsDir, 'sha1-client-ca.pem');
			await writeFile(serverCertPath, chain.serverCertPem);
			await writeFile(serverKeyPath, chain.serverKeyPem);
			await writeFile(caPath, chain.caPem);

			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					http: {
						// required: the handshake itself gates — a client chain that fails verification is
						// refused at the TLS layer, which is what makes the assertions below protocol-level
						mtls: { user: 'admin', required: true },
					},
					tls: [
						{ certificate: serverCertPath, privateKey: serverKeyPath },
						// the previously-ignored position: not tls.ciphers, not tls[0].ciphers
						{ certificateAuthority: caPath, ciphers: RELAXED_CIPHERS },
					],
				},
			});
		});

		after(async () => {
			// before() can fail prior to certsDir being assigned; still tear Harper down, and only
			// remove what was actually created
			try {
				await teardownHarper(ctx);
			} finally {
				if (certsDir) await rm(certsDir, { recursive: true, force: true, maxRetries: 3 });
			}
		});

		test('accepts a client cert chained through the SHA-1-signed CA', async () => {
			// with mtls.required, reaching HTTP at all means the chain verified — the TLS layer would
			// otherwise have refused the handshake (exactly what happened while the SECLEVEL was ignored)
			const status = await requestStatus(ctx.harper.hostname, {
				cert: chain.clientCertPem,
				key: chain.clientKeyPem,
			});
			ok(status !== 401, `expected the SHA-1-chained client cert to authenticate (got ${status})`);
		});

		test('still refuses a client cert that does not chain to the CA (verification actually gates)', async () => {
			await rejects(
				requestStatus(ctx.harper.hostname, {
					cert: chain.unchainedCertPem,
					key: chain.unchainedKeyPem,
				}),
				// the exact error varies (TLS alert vs connection reset, and by platform) — any refusal counts
				(error: Error) => Boolean(error),
				'expected the TLS handshake to be refused for an unchained client cert'
			);
		});
	}
);
