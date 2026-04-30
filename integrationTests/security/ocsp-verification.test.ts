/**
 * OCSP Certificate Verification Integration Tests
 *
 * Tests Harper's OCSP (Online Certificate Status Protocol) certificate verification
 * using the new integration test infrastructure. Each test runs in isolation with its
 * own Harper instance, certificates, and OCSP responder.
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
	setupOcspResponderWithCerts,
	stopOcspResponder,
	type OcspResponderContext,
	type OcspCertificates,
} from '../utils/securityServices.ts';
import { generateOcspCertificates } from '../utils/security/ocsp/generate-test-certs.ts';

const HTTPS_PORT = 9927;
const FIXTURE_PATH = join(import.meta.dirname, 'fixture');

// The last test stops the OCSP responder to verify caching, so tests must run sequentially.
// Tests CANNOT run concurrently because the caching test stops the responder that earlier tests need.
suite(
	'OCSP Certificate Verification',
	{ concurrency: 1 }, // Explicit: tests must run in order
	(ctx: ContextWithHarper) => {
		let ocspResponder: OcspResponderContext | null = null;
		let certsPath: string; // Track separately for cleanup even if responder is stopped

		before(async () => {
			// 1. Create temp directory for certificates
			certsPath = await mkdtemp(join(tmpdir(), 'harper-ocsp-test-'));

			// 2. Setup OCSP responder (picks port, generates certs, starts responder with retry)
			ocspResponder = await setupOcspResponderWithCerts(certsPath);

			// 3. Setup Harper with fixture pre-installed and CA certificate configuration
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					http: {
						mtls: {
							user: 'admin',
							certificateVerification: {
								failureMode: 'fail-closed',
								ocsp: {
									enabled: true,
									timeout: 5000,
									cacheTtl: 3600000,
								},
							},
						},
					},
					tls: {
						certificateAuthority: ocspResponder.certs.ca,
					},
				},
			});
		});

		after(async () => {
			// 1. Stop OCSP responder (if not already stopped by caching test)
			if (ocspResponder) {
				await stopOcspResponder(ocspResponder);
			}

			// 2. Teardown Harper (before removing certs in case Harper is using them)
			await teardownHarper(ctx);

			// 3. Cleanup certificates (always cleanup, even if responder was stopped early)
			await rm(certsPath, { recursive: true, force: true, maxRetries: 3 });
		});

		test('should accept valid certificate with OCSP check', async () => {
			return new Promise<void>((resolve, reject) => {
				const req = https.request(
					`https://${ctx.harper.hostname}:${HTTPS_PORT}/`,
					{
						cert: readFileSync(ocspResponder!.certs.valid.cert),
						key: readFileSync(ocspResponder!.certs.valid.key),
						ca: readFileSync(ocspResponder!.certs.ca),
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

		test('should reject revoked certificate with OCSP check', async () => {
			return new Promise<void>((resolve, reject) => {
				const req = https.request(
					`https://${ctx.harper.hostname}:${HTTPS_PORT}/`,
					{
						cert: readFileSync(ocspResponder!.certs.revoked.cert),
						key: readFileSync(ocspResponder!.certs.revoked.key),
						ca: readFileSync(ocspResponder!.certs.ca),
						rejectUnauthorized: false,
					},
					(res) => {
						res.resume();
						ok(res.statusCode === 401, `Expected 401 for revoked cert, got: ${res.statusCode}`);
						res.on('end', () => resolve());
					}
				);

				req.on('error', (err: any) => {
					reject(new Error(`Expected application-level rejection (401), got TLS error: ${err.code || err.message}`));
				});

				req.end();
			});
		});

		test('should cache OCSP responses and serve valid certificate after responder stops', async () => {
			const validCert = readFileSync(ocspResponder!.certs.valid.cert);
			const validKey = readFileSync(ocspResponder!.certs.valid.key);
			const ca = readFileSync(ocspResponder!.certs.ca);

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

			// Stop OCSP responder to prove caching works.
			// Set to null so after() hook knows responder is already stopped.
			if (ocspResponder) {
				await stopOcspResponder(ocspResponder);
				ocspResponder = null;
			}

			// Second request - should succeed using cached OCSP response
			const status2 = await makeRequest();
			ok(status2 !== 401, `Second request should be accepted with cached OCSP (not 401), got ${status2}`);
		});
	}
);

suite('OCSP Certificate Verification - Disabled', (ctx: ContextWithHarper) => {
	let certsPath: string;
	let certs: OcspCertificates;

	before(async () => {
		certsPath = await mkdtemp(join(tmpdir(), 'harper-ocsp-disabled-'));
		// No OCSP responder started - OCSP is disabled and won't be accessed
		certs = (await generateOcspCertificates(certsPath, '127.0.0.1', 58888)).files;

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

	test('should accept certificate when OCSP is disabled', async () => {
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
					ok(res.statusCode !== 401, `Expected non-401 (OCSP disabled, cert accepted). Got: ${res.statusCode}`);
					res.on('end', () => resolve());
				}
			);
			req.on('error', (err) => reject(new Error(`Request failed: ${err.message}`)));
			req.end();
		});
	});
});

suite('OCSP Certificate Verification - Fail-Open Mode', (ctx: ContextWithHarper) => {
	let certsPath: string;
	let certs: OcspCertificates;

	before(async () => {
		certsPath = await mkdtemp(join(tmpdir(), 'harper-ocsp-failopen-'));
		// No OCSP responder started - this will cause OCSP check to fail
		certs = (await generateOcspCertificates(certsPath, '127.0.0.1', 58888)).files;

		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				http: {
					mtls: {
						user: 'admin',
						certificateVerification: {
							failureMode: 'fail-open',
							ocsp: {
								enabled: true,
								timeout: 1000, // Very short timeout to trigger failure
								cacheTtl: 3600000,
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

	test('should allow connection in fail-open mode when OCSP unavailable', async () => {
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
					ok(res.statusCode !== 401, `Expected non-401 in fail-open mode (OCSP unavailable). Got: ${res.statusCode}`);
					res.on('end', () => resolve());
				}
			);
			req.on('error', (err) => reject(new Error(`Request failed: ${err.message}`)));
			req.end();
		});
	});
});

suite('OCSP Certificate Verification - Fail-Closed with Timeout', (ctx: ContextWithHarper) => {
	let certsPath: string;
	let certs: OcspCertificates;

	before(async () => {
		certsPath = await mkdtemp(join(tmpdir(), 'harper-ocsp-timeout-'));
		// No OCSP responder started - this will cause OCSP check to fail
		certs = (await generateOcspCertificates(certsPath, '127.0.0.1', 58888)).files;

		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				http: {
					mtls: {
						user: 'admin',
						certificateVerification: {
							failureMode: 'fail-closed',
							ocsp: {
								enabled: true,
								timeout: 1000, // Very short timeout
								cacheTtl: 3600000,
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

	test('should reject connection in fail-closed mode when OCSP times out', async () => {
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
					ok(res.statusCode === 401, `Expected 401 in fail-closed mode when OCSP times out. Got: ${res.statusCode}`);
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
