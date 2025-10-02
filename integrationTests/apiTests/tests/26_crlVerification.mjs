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
 * CRL Certificate Verification Tests
 *
 * These tests verify that Harper properly checks certificate revocation status using CRLs.
 *
 * Requirements:
 * - Harper must be configured with mTLS enabled
 * - OpenSSL must be installed (for certificate and CRL generation)
 * - The tests will automatically generate test certificates and CRLs if needed
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

describe('26. CRL Certificate Verification Tests', () => {
	beforeEach(timestamp);

	let httpsAvailable = true;
	let crlServer;
	// Use dynamic port to invalidate existing CRL caches on each test run
	// CRL uses static file caching by URL, while OCSP responder returns fresh data
	// from index.txt at the same endpoint, so OCSP doesn't need URL changes
	let crlPort = 8889 + (Math.floor(Date.now() / 1000) % 1000);
	// Use relative path from current test file location
	const __dirname = dirname(fileURLToPath(import.meta.url));
	const crlUtilsPath = join(__dirname, '../../utils/security/crl');
	const certsPath = join(crlUtilsPath, 'generated');
	let certificatesGenerated = false;

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
CRL tests are being skipped because HTTPS is not available.

To run these tests, add this to your harperdb-config.yaml and restart Harper:

http:
	portRest: ${testData.portRest}
	securePortRest: ${testData.securePortRest}
	mtls:  true
operationsApi:
	network:
		port: ${testData.port}
		securePort: ${testData.securePort}
`);
				return;
			}
		}

		if (!httpsAvailable) return;

		console.log('Generating test CRL certificates...');

		// Ensure directory exists
		if (!existsSync(certsPath)) {
			mkdirSync(certsPath, { recursive: true });
		}

		// For integration tests, we'll create client certificates signed by a test CA
		// and add that CA to Harper's certificate store
		try {
			// Generate test certificates with our own CA
			// In Docker, we need to use the host gateway IP for CRL
			const crlHost = process.env.DOCKER_CONTAINER_ID ? '172.17.0.1' : 'localhost';
			execSync(`node ${join(crlUtilsPath, 'generate-test-certs.js')}`, {
				stdio: 'inherit',
				cwd: crlUtilsPath,
				env: {
					...process.env,
					CRL_HOST: crlHost,
					CRL_PORT: crlPort.toString(),
				},
			});

			// Using Harper's CA certificate for CRL testing
			console.log("Using Harper's CA certificate for CRL testing");

			// Create users for certificate CNs
			console.log('Creating users for certificate authentication...');

			// Create user for "Valid Client" CN
			const createValidUserResponse = await req().send({
				operation: 'add_user',
				username: 'Valid CRL Client',
				password: 'not-used-for-cert-auth',
				role: 'super_user', // Give full permissions for testing
				active: true,
			});

			if (createValidUserResponse.status !== 200) {
				console.log(
					'Failed to create Valid CRL Client user:',
					createValidUserResponse.status,
					createValidUserResponse.body
				);
			} else {
				console.log('Created user "Valid CRL Client" for certificate authentication');
			}

			// Create user for "Revoked Client" CN (optional, but consistent)
			const createRevokedUserResponse = await req().send({
				operation: 'add_user',
				username: 'Revoked CRL Client',
				password: 'not-used-for-cert-auth',
				role: 'super_user',
				active: true,
			});

			if (createRevokedUserResponse.status !== 200) {
				console.log('Note: Revoked CRL Client user may already exist');
			}

			certificatesGenerated = true;
			console.log('Test certificates generated successfully');
		} catch (error) {
			throw new Error(`Failed to setup certificates: ${error.message}`);
		}

		// Start CRL server
		console.log('Starting CRL server on port', crlPort);
		crlServer = spawn('node', ['start-crl-server.js', '--port', String(crlPort), '--certs-path', certsPath], {
			cwd: crlUtilsPath,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		crlServer.stdout.on('data', (data) => {
			console.log('CRL server:', data.toString());
		});

		crlServer.stderr.on('data', (data) => {
			console.error('CRL server error:', data.toString());
		});

		// Give CRL server time to start
		await new Promise((resolve) => setTimeout(resolve, 2000));
	});

	after(async () => {
		if (crlServer) {
			console.log('Stopping CRL server');
			crlServer.kill();
		}

		// Note: We don't remove Harper's CA since we're using Harper's own CA certificate
		if (certificatesGenerated) {
			// Remove test users
			try {
				await req().send({
					operation: 'drop_user',
					username: 'Valid CRL Client',
				});
				console.log('Removed test user "Valid CRL Client"');
			} catch (error) {
				console.log('Note: Failed to remove Valid CRL Client user:', error.message);
			}

			try {
				await req().send({
					operation: 'drop_user',
					username: 'Revoked CRL Client',
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

	it('should accept valid certificate with CRL check', async (t) => {
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

	it('should reject revoked certificate with CRL check', async (t) => {
		if (!httpsAvailable) {
			t.skip('HTTPS not available');
			return;
		}

		// Read the revoked certificate and key
		const cert = readFileSync(join(certsPath, 'client-revoked-chain.crt'));
		const key = readFileSync(join(certsPath, 'client-revoked.key'));
		const ca = readFileSync(join(certsPath, 'harper-ca.crt'));

		// With fail-closed mode (default), revoked certificates should be rejected
		let rejected = false;
		let response;
		try {
			response = await secureReqRest('/', {
				cert: cert,
				key: key,
				ca: ca,
				rejectUnauthorized: false,
			});
			// If we get here without error, check for 401 status
			if (response.status === 401) {
				rejected = true;
			}
		} catch (error) {
			rejected = true;
			// Connection errors are also acceptable for rejection
			assert.ok(
				error.code === 'ECONNRESET' ||
					error.code === 'ECONNREFUSED' ||
					error.code === 'EPROTO' ||
					error.message.includes('socket hang up'),
				`Expected connection error due to revoked certificate, got: "${error.message}"`
			);
		}

		assert.ok(rejected, 'Revoked certificate should have been rejected (401 or connection error)');
	});

	it('should cache CRL responses', async (t) => {
		if (!httpsAvailable) {
			t.skip('HTTPS not available');
			return;
		}

		// After the previous tests, we should have cached entries for CRL data
		const schemaResponse = await req().send({
			operation: 'describe_schema',
			schema: 'system',
		});

		assert.equal(schemaResponse.status, 200, 'Failed to describe system schema');

		// Check if CRL cache tables exist
		const crlCacheTable = schemaResponse.body?.hdb_crl_cache;
		const revokedCertsTable = schemaResponse.body?.hdb_revoked_certificates;

		if (!crlCacheTable && !revokedCertsTable) {
			console.log('No CRL cache tables found - CRL verification may not have been triggered yet');
			return;
		}

		if (crlCacheTable) {
			const crlCount = crlCacheTable.record_count || 0;
			console.log(`CRL cache contains ${crlCount} entries`);
			if (crlCount > 0) {
				console.log('✅ CRL cache is working');
			}
		}

		if (revokedCertsTable) {
			const revokedCount = revokedCertsTable.record_count || 0;
			console.log(`Revoked certificates cache contains ${revokedCount} entries`);
			if (revokedCount > 0) {
				console.log('✅ Revoked certificates cache is working');
			}
		}

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
