import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testData } from '../config/envConfig.mjs';
import { req, secureReq, secureReqRest } from '../utils/request.mjs';
import { timestamp } from '../utils/timestamp.mjs';

/**
 * OCSP Certificate Verification Tests
 *
 * These tests verify that Harper properly checks certificate revocation status using OCSP.
 *
 * Requirements:
 * - Harper must be configured with mTLS enabled
 * - OpenSSL must be installed (for OCSP responder)
 * - The tests will automatically generate test certificates if needed
 *
 * Example Harper configuration:
 * ```yaml
 * http:
 * 	portRest: 9926
 * 	securePortRest: 9953
 * 	mtls: true
 * operationsApi:
 * 	network:
 * 		port: 9925
 * 		securePort: 9943
 * ```
 */

describe('24. OCSP Certificate Verification Tests', () => {
	beforeEach(timestamp);
	
	let httpsAvailable = true;
	let ocspResponder;
	let ocspPort = 8888;
	// Use relative path from current test file location
	const __dirname = dirname(fileURLToPath(import.meta.url));
	const ocspUtilsPath = join(__dirname, '../../utils/security/ocsp');
	const certsPath = join(ocspUtilsPath, 'generated');
	let certificatesGenerated = false;

	// Out of order test just to emphasize the initial state
	// This test checks if the certificate cache is empty before any OCSP tests run
	it('should start with empty certificate cache', async (t) => {
		if (!httpsAvailable) {
			t.skip('HTTPS not available');
			return;
		}

		// Check if certificate cache table exists
		const schemaResponse = await req().send({
			operation: 'describe_schema',
			schema: 'system',
		});

		assert.equal(schemaResponse.status, 200, 'Failed to describe system schema');

		const cacheTable = schemaResponse.body?.hdb_certificate_cache;
		if (!cacheTable) {
			console.log('Certificate cache table not found - database is clean (expected)');
			// This is the expected state - no certificate cache table
			return;
		}

		const count = cacheTable.record_count || 0;
		console.log(`Initial certificate cache contains ${count} entries`);

		// If there's a cache table, the database isn't clean
		assert.fail(`Certificate cache table exists with ${count} entries - database is not clean`);
	});

	before(async function () {
		// Check if HTTPS is available on both endpoints
		try {
			// Check operations endpoint (used for certificate management)
			await secureReq().send({ operation: 'describe_all' }).timeout(2000);
			// Check REST endpoint (used for certificate verification tests)
			await secureReqRest('/').timeout(2000);
		} catch (error) {
			if (error.code === 'ECONNREFUSED' || error.message.includes('ECONNREFUSED')) {
				httpsAvailable = false;
				console.log(`
OCSP tests are being skipped because HTTPS is not available.

To run these tests, add this to your harperdb-config.yaml and restart Harper:

http:
	portRest: ${testData.portRest}
	securePortRest: ${testData.securePortRest}
	mtls: true
operationsApi:
	network:
		port: ${testData.port}
		securePort: ${testData.securePort}
`);
				return;
			}
		}

		if (!httpsAvailable) return;

		console.log('Generating test certificates...');

		// Ensure directory exists
		if (!existsSync(certsPath)) {
			mkdirSync(certsPath, { recursive: true });
		}

		// For integration tests, we'll create client certificates signed by a test CA
		// and add that CA to Harper's certificate store
		try {
			// Generate test certificates with our own CA
			// In Docker, we need to use the host gateway IP for OCSP
			const ocspHost = process.env.DOCKER_CONTAINER_ID ? '172.17.0.1' : 'localhost';
			execSync(`node ${join(ocspUtilsPath, 'generate-test-certs.js')}`, {
				stdio: 'inherit',
				cwd: ocspUtilsPath,
				env: {
					...process.env,
					OCSP_HOST: ocspHost,
				},
			});

			// Read the generated CA certificate
			const testCA = readFileSync(join(certsPath, 'harper-ca.crt'), 'utf8');

			// Add our test CA to Harper's certificate store
			const addCAResponse = await req().send({
				operation: 'add_certificate',
				name: 'ocsp-test-ca',
				certificate: testCA,
				is_authority: true,
				uses: ['client_authentication'],
			});

			if (addCAResponse.status !== 200) {
				// CA might already exist, which is fine
				console.log('Note: Test CA may already exist in Harper');
			} else {
				console.log('Test CA added to Harper successfully');
			}

			// Create users for certificate CNs
			console.log('Creating users for certificate authentication...');

			// Create user for "Valid Client" CN
			const createValidUserResponse = await req().send({
				operation: 'add_user',
				username: 'Valid Client',
				password: 'not-used-for-cert-auth',
				role: 'super_user', // Give full permissions for testing
				active: true,
			});

			if (createValidUserResponse.status !== 200) {
				console.log(
					'Failed to create Valid Client user:',
					createValidUserResponse.status,
					createValidUserResponse.body
				);
			} else {
				console.log('Created user "Valid Client" for certificate authentication');
			}

			// Create user for "Revoked Client" CN (optional, but consistent)
			const createRevokedUserResponse = await req().send({
				operation: 'add_user',
				username: 'Revoked Client',
				password: 'not-used-for-cert-auth',
				role: 'super_user',
				active: true,
			});

			if (createRevokedUserResponse.status !== 200) {
				console.log('Note: Revoked Client user may already exist');
			}

			certificatesGenerated = true;
			console.log('Test certificates generated successfully');
		} catch (error) {
			throw new Error(`Failed to setup certificates: ${error.message}`);
		}

		// Start OCSP responder
		console.log('Starting OCSP responder on port', ocspPort);
		ocspResponder = spawn(
			'openssl',
			[
				'ocsp',
				'-port',
				String(ocspPort),
				'-text',
				'-index',
				join(certsPath, 'index.txt'),
				'-CA',
				join(certsPath, 'harper-ca.crt'),
				'-rkey',
				join(certsPath, 'ocsp.key'),
				'-rsigner',
				join(certsPath, 'ocsp.crt'),
				'-nrequest',
				'100',
			],
			{
				cwd: ocspUtilsPath,
				stdio: ['ignore', 'pipe', 'pipe'],
			}
		);

		ocspResponder.stdout.on('data', (data) => {
			console.log('OCSP responder:', data.toString());
		});

		ocspResponder.stderr.on('data', (data) => {
			console.error('OCSP responder error:', data.toString());
		});

		// Give OCSP responder time to start
		await new Promise((resolve) => setTimeout(resolve, 2000));
	});

	after(async () => {
		if (ocspResponder) {
			console.log('Stopping OCSP responder');
			ocspResponder.kill();
		}

		// Remove test CA from Harper
		if (certificatesGenerated) {
			try {
				await req().send({
					operation: 'remove_certificate',
					name: 'ocsp-test-ca',
				});
				console.log('Test CA removed from Harper');
			} catch (error) {
				console.log('Note: Failed to remove test CA:', error.message);
			}

			// Remove test users
			try {
				await req().send({
					operation: 'drop_user',
					username: 'Valid Client',
				});
				console.log('Removed test user "Valid Client"');
			} catch (error) {
				console.log('Note: Failed to remove Valid Client user:', error.message);
			}

			try {
				await req().send({
					operation: 'drop_user',
					username: 'Revoked Client',
				});
			} catch (error) {
				// Silently ignore
			}
		}

		// Optionally clean up generated certificates
		if (certificatesGenerated && process.env.CLEANUP_TEST_CERTS === 'true') {
			console.log('Cleaning up generated certificates');
			try {
				rmSync(certsPath, { recursive: true, force: true });
			} catch (error) {
				console.error('Failed to clean up certificates:', error.message);
			}
		}
	});

	it('should reject revoked certificate with OCSP check', async (t) => {
		if (!httpsAvailable) {
			t.skip('HTTPS not available');
			return;
		}

		// Read the revoked certificate and key
		const cert = readFileSync(join(certsPath, 'client-revoked-chain.crt'));
		const key = readFileSync(join(certsPath, 'client-revoked.key'));
		const ca = readFileSync(join(certsPath, 'harper-ca.crt'));
		try {
			await secureReqRest('/', {
				cert: cert,
				key: key,
				ca: ca,
				rejectUnauthorized: false,
			}).expect(401); // Should reject revoked certificate
		} catch (error) {
			// Connection errors are expected if certificate is rejected early
			assert.ok(
				error.code === 'ECONNRESET' ||
					error.code === 'ECONNREFUSED' ||
					error.code === 'EPROTO' ||
					error.message.includes('socket hang up'),
				`Expected connection error due to revoked certificate, got: ${error.message}`
			);
		}
	});

	it('should accept valid certificate with OCSP check', async (t) => {
		if (!httpsAvailable) {
			t.skip('HTTPS not available');
			return;
		}

		// Read the valid certificate and key
		const cert = readFileSync(join(certsPath, 'client-valid-chain.crt'));
		const key = readFileSync(join(certsPath, 'client-valid.key'));
		const ca = readFileSync(join(certsPath, 'harper-ca.crt'));

		try {
			const response = await secureReqRest('/', {
				cert: cert,
				key: key,
				ca: ca,
				rejectUnauthorized: false,
			});

			// Valid certificate should be accepted (may return 404 if no route, but connection succeeds)
			assert.ok(
				response.status === 200 || response.status === 404,
				`Valid certificate should be accepted. Got: ${response.status} - ${response.text}`
			);
		} catch (error) {
			// Log more details about the error
			console.error('Valid certificate test failed:', error);
			throw error;
		}
	});

	it('should cache OCSP responses', async (t) => {
		if (!httpsAvailable) {
			t.skip('HTTPS not available');
			return;
		}

		// After the previous tests, we should have cached entries for both valid and revoked certificates
		const schemaResponse = await req().send({
			operation: 'describe_schema',
			schema: 'system',
		});

		assert.equal(schemaResponse.status, 200, 'Failed to describe system schema');

		// Check if certificate cache table exists
		const cacheTable = schemaResponse.body?.hdb_certificate_cache;
		if (!cacheTable) {
			assert.fail('Certificate cache table not found - OCSP verification is not working');
			return;
		}

		const cacheCount = cacheTable.record_count || 0;
		console.log(`Certificate cache contains ${cacheCount} entries`);

		// We expect at least 2 entries: one for valid cert, one for revoked cert
		// (certificates might generate different IDs each run, so we might have more)
		assert.ok(cacheCount >= 2, `Cache should contain at least 2 entries (valid + revoked). Found: ${cacheCount}`);

		// Verify caching works by making multiple requests
		const cert = readFileSync(join(certsPath, 'client-valid-chain.crt'));
		const key = readFileSync(join(certsPath, 'client-valid.key'));

		const ca = readFileSync(join(certsPath, 'harper-ca.crt'));

		// Make two requests in quick succession - second should use cache
		const response1 = await secureReqRest('/', {
			cert: cert,
			key: key,
			ca: ca,
			rejectUnauthorized: false,
		});

		const response2 = await secureReqRest('/', {
			cert: cert,
			key: key,
			ca: ca,
			rejectUnauthorized: false,
		});

		assert.ok(
			response1.status === 200 || response1.status === 404,
			`First request should work. Got: ${response1.status}`
		);
		assert.ok(
			response2.status === 200 || response2.status === 404,
			`Second request (cached) should work. Got: ${response2.status}`
		);
	});
});
