/**
 * CRL Certificate Verification Integration Tests
 *
 * Tests Harper's CRL (Certificate Revocation List) certificate verification
 * using the new integration test infrastructure. Each test runs in isolation with its
 * own Harper instance, certificates, and CRL server.
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as https from 'node:https';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import {
	generateCrlCertificates,
	setupCrlServerWithCerts,
	stopCrlServer,
	type CrlServerContext,
	type CrlCertificates,
} from '../utils/securityServices.ts';

const HTTPS_PORT = 9927;
const FIXTURE_PATH = join(import.meta.dirname, 'fixture');

// The last test stops the CRL server to verify caching, so tests must run sequentially.
// Tests CANNOT run concurrently because the caching test stops the server that earlier tests need.
suite(
	'CRL Certificate Verification',
	{ concurrency: 1 }, // Explicit: tests must run in order
	(ctx: ContextWithHarper) => {
		let crlServer: CrlServerContext | null = null;
		let certsPath: string; // Track separately for cleanup even if server is stopped

		before(async () => {
			// 1. Create temp directory for certificates
			certsPath = await mkdtemp(join(tmpdir(), 'harper-crl-test-'));

			// 2. Setup CRL server (picks port, generates certs, starts server with retry)
			crlServer = await setupCrlServerWithCerts(certsPath);

			// 3. Setup Harper with fixture pre-installed and CA certificate configuration
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					http: {
						mtls: {
							user: 'admin',
							certificateVerification: {
								failureMode: 'fail-closed',
								crl: {
									enabled: true,
									timeout: 30000,
									cacheTtl: 604800000, // 7 days
								},
								ocsp: {
									enabled: false,
								},
							},
						},
					},
					tls: {
						certificateAuthority: crlServer.certs.ca,
					},
				},
			});
		});

		after(async () => {
			// 1. Stop CRL server (if not already stopped by caching test)
			if (crlServer) {
				await stopCrlServer(crlServer);
			}

			// 2. Teardown Harper (before removing certs in case Harper is using them)
			await teardownHarper(ctx);

			// 3. Cleanup certificates (always cleanup, even if server was stopped early)
			await rm(certsPath, { recursive: true, force: true, maxRetries: 3 });
		});

		test('should accept valid certificate with CRL check', async () => {
			return new Promise<void>((resolve, reject) => {
				const req = https.request(
					`https://${ctx.harper.hostname}:${HTTPS_PORT}/`,
					{
						cert: readFileSync(crlServer!.certs.valid.cert),
						key: readFileSync(crlServer!.certs.valid.key),
						ca: readFileSync(crlServer!.certs.ca),
						rejectUnauthorized: false, // Harper uses self-signed server cert
					},
					(res) => {
						res.resume();
						ok(res.statusCode !== 401, `Expected non-401 for valid cert (cert accepted). Got: ${res.statusCode}`);
						res.on('end', () => resolve());
					}
				);

				req.on('error', (err) => reject(new Error(`Request failed: ${err.message}`)));
				req.end();
			});
		});

		test('should reject revoked certificate with CRL check', async () => {
			return new Promise<void>((resolve, reject) => {
				const req = https.request(
					`https://${ctx.harper.hostname}:${HTTPS_PORT}/`,
					{
						cert: readFileSync(crlServer!.certs.revoked.cert),
						key: readFileSync(crlServer!.certs.revoked.key),
						ca: readFileSync(crlServer!.certs.ca),
						rejectUnauthorized: false,
					},
					(res) => {
						res.resume();
						ok(res.statusCode === 401, `Expected 401 for revoked cert, got: ${res.statusCode}`);
						res.on('end', () => resolve());
					}
				);

				req.on('timeout', () => {
					req.destroy();
					reject(new Error('Request timeout - connection hung'));
				});

				req.on('error', (err: any) => {
					reject(new Error(`Expected application-level rejection (401), got TLS error: ${err.code || err.message}`));
				});

				req.end();
			});
		});

		test('should cache CRL and serve valid certificate after CRL server stops', async () => {
			const validCert = readFileSync(crlServer!.certs.valid.cert);
			const validKey = readFileSync(crlServer!.certs.valid.key);
			const ca = readFileSync(crlServer!.certs.ca);

			const makeRequest = () =>
				new Promise<number>((resolve, reject) => {
					const req = https.request(
						`https://${ctx.harper.hostname}:${HTTPS_PORT}/`,
						{ cert: validCert, key: validKey, ca, rejectUnauthorized: false },
						(res) => {
							res.resume();
							res.on('end', () => resolve(res.statusCode!));
						}
					);
					req.on('error', reject);
					req.end();
				});

			// First request - populates cache
			const status1 = await makeRequest();
			ok(status1 !== 401, `First request should be accepted (not 401), got ${status1}`);

			// Stop CRL server to prove caching works.
			// Set to null so after() hook knows server is already stopped.
			if (crlServer) {
				await stopCrlServer(crlServer);
				crlServer = null;
			}

			// Second request - should succeed using cached CRL
			const status2 = await makeRequest();
			ok(status2 !== 401, `Second request should be accepted with cached CRL (not 401), got ${status2}`);
		});
	}
);

suite('CRL Certificate Verification - Disabled', (ctx: ContextWithHarper) => {
	let certsPath: string;
	let certs: CrlCertificates;

	before(async () => {
		certsPath = await mkdtemp(join(tmpdir(), 'harper-crl-disabled-'));
		// Use placeholder port since CRL is disabled and won't be accessed
		certs = await generateCrlCertificates(certsPath, '127.0.0.1', 19999);

		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				http: {
					mtls: {
						user: 'admin',
						certificateVerification: {
							failureMode: 'fail-closed',
							crl: {
								enabled: false,
							},
							ocsp: {
								enabled: false,
							},
						},
					},
				},
				tls: {
					certificateAuthority: certs.ca,
				},
			},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
		await rm(certsPath, { recursive: true, force: true, maxRetries: 3 });
	});

	test('should accept certificate when CRL is disabled', async () => {
		return new Promise<void>((resolve, reject) => {
			const req = https.request(
				`https://${ctx.harper.hostname}:${HTTPS_PORT}/`,
				{
					cert: readFileSync(certs.valid.cert),
					key: readFileSync(certs.valid.key),
					ca: readFileSync(certs.ca),
					rejectUnauthorized: false,
				},
				(res) => {
					res.resume();
					ok(res.statusCode !== 401, `Expected non-401 (CRL disabled, cert accepted). Got: ${res.statusCode}`);
					res.on('end', () => resolve());
				}
			);
			req.on('error', (err) => reject(new Error(`Request failed: ${err.message}`)));
			req.end();
		});
	});
});

suite('CRL Certificate Verification - Fail-Open Mode', (ctx: ContextWithHarper) => {
	let certsPath: string;
	let certs: CrlCertificates;

	before(async () => {
		certsPath = await mkdtemp(join(tmpdir(), 'harper-crl-failopen-'));
		// No CRL server started - this will cause CRL fetch to fail
		certs = await generateCrlCertificates(certsPath, '127.0.0.1', 19999);

		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				http: {
					mtls: {
						user: 'admin',
						certificateVerification: {
							failureMode: 'fail-open',
							crl: {
								enabled: true,
								timeout: 1000, // Very short timeout to trigger failure
								cacheTtl: 604800000,
							},
						},
					},
				},
				tls: {
					certificateAuthority: certs.ca,
				},
			},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
		await rm(certsPath, { recursive: true, force: true, maxRetries: 3 });
	});

	test('should allow connection in fail-open mode when CRL unavailable', async () => {
		return new Promise<void>((resolve, reject) => {
			const req = https.request(
				`https://${ctx.harper.hostname}:${HTTPS_PORT}/`,
				{
					cert: readFileSync(certs.valid.cert),
					key: readFileSync(certs.valid.key),
					ca: readFileSync(certs.ca),
					rejectUnauthorized: false,
				},
				(res) => {
					res.resume();
					ok(res.statusCode !== 401, `Expected non-401 in fail-open mode (CRL unavailable). Got: ${res.statusCode}`);
					res.on('end', () => resolve());
				}
			);
			req.on('error', (err) => reject(new Error(`Request failed: ${err.message}`)));
			req.end();
		});
	});
});

suite('CRL Certificate Verification - Fail-Closed with Timeout', (ctx: ContextWithHarper) => {
	let certsPath: string;
	let certs: CrlCertificates;

	before(async () => {
		certsPath = await mkdtemp(join(tmpdir(), 'harper-crl-timeout-'));
		// No CRL server started - this will cause CRL fetch to fail
		certs = await generateCrlCertificates(certsPath, '127.0.0.1', 19999);

		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				http: {
					mtls: {
						user: 'admin',
						certificateVerification: {
							failureMode: 'fail-closed',
							crl: {
								enabled: true,
								timeout: 1000, // Very short timeout
								cacheTtl: 604800000,
							},
						},
					},
				},
				tls: {
					certificateAuthority: certs.ca,
				},
			},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
		await rm(certsPath, { recursive: true, force: true, maxRetries: 3 });
	});

	test('should reject connection in fail-closed mode when CRL times out', async () => {
		return new Promise<void>((resolve) => {
			const req = https.request(
				`https://${ctx.harper.hostname}:${HTTPS_PORT}/`,
				{
					cert: readFileSync(certs.valid.cert),
					key: readFileSync(certs.valid.key),
					ca: readFileSync(certs.ca),
					rejectUnauthorized: false,
				},
				(res) => {
					res.resume();
					ok(res.statusCode === 401, `Expected 401 in fail-closed mode when CRL times out. Got: ${res.statusCode}`);
					res.on('end', () => resolve());
				}
			);
			req.on('error', (err: any) => {
				// Connection-level rejection is also acceptable
				ok(
					err.code === 'ECONNRESET' ||
						err.code === 'EPROTO' ||
						err.message?.includes('socket hang up') ||
						err.message?.includes('certificate') ||
						err.message?.includes('closed'),
					`Expected connection error in fail-closed mode, got: ${err.code || err.message}`
				);
				resolve();
			});
			req.end();
		});
	});
});
