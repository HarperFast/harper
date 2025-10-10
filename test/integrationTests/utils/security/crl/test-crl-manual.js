#!/usr/bin/env node

/**
 * Test CRL verification manually by making mTLS requests to Harper
 */

const https = require('node:https');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

// Harper endpoints (adjust ports if needed)
const HARPER_SECURE_PORT = 9943; // Operations API secure port
const HARPER_REST_SECURE_PORT = 9953; // REST API secure port

async function makeSecureRequest(certPath, keyPath, caCertPath, endpoint = 'operations') {
	return new Promise((resolve) => {
		// Determine port and path based on endpoint type
		const port = endpoint === 'rest' ? HARPER_REST_SECURE_PORT : HARPER_SECURE_PORT;
		const path = '/';

		const options = {
			hostname: 'localhost',
			port: port,
			path: path,
			method: endpoint === 'rest' ? 'GET' : 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Basic ' + Buffer.from('admin:password').toString('base64'),
			},
			// mTLS configuration
			cert: readFileSync(certPath),
			key: readFileSync(keyPath),
			ca: readFileSync(caCertPath),
			rejectUnauthorized: true,
			requestCert: true,
			checkServerIdentity: () => undefined, // Skip server identity check for localhost
		};

		const req = https.request(options, (res) => {
			let data = '';

			res.on('data', (chunk) => {
				data += chunk;
			});

			res.on('end', () => {
				console.log(`  Status: ${res.statusCode} ${res.statusMessage}`);
				console.log(`  TLS Info: Protocol=${res.socket.getProtocol()}, Cipher=${res.socket.getCipher()?.name}`);

				resolve({
					statusCode: res.statusCode,
					statusMessage: res.statusMessage,
					data: data,
					tlsInfo: {
						protocol: res.socket.getProtocol(),
						cipher: res.socket.getCipher(),
						peerCertificate: res.socket.getPeerCertificate(),
					},
				});
			});
		});

		req.on('error', (error) => {
			console.log(`  Error: ${error.message}`);
			resolve({
				error: error.message,
				statusCode: null,
			});
		});

		// Send a simple describe_all operation for operations endpoint
		if (endpoint === 'operations') {
			req.write(
				JSON.stringify({
					operation: 'describe_all',
				})
			);
		}

		req.end();
	});
}

async function testCRL() {
	const certsDir = join(__dirname, 'generated');

	try {
		console.log('Testing CRL verification via mTLS requests to Harper...\n');

		// Check if certificates exist
		const serverCertPath = join(certsDir, 'server.crt');
		const serverKeyPath = join(certsDir, 'server.key');
		const revokedCertPath = join(certsDir, 'revoked.crt');
		const revokedKeyPath = join(certsDir, 'revoked.key');
		const caCertPath = join(certsDir, 'harper-ca.crt');

		if (
			!existsSync(serverCertPath) ||
			!existsSync(serverKeyPath) ||
			!existsSync(revokedCertPath) ||
			!existsSync(revokedKeyPath) ||
			!existsSync(caCertPath)
		) {
			console.error('❌ Test certificates not found. Run generate-crl-certs.js first.');
			process.exit(1);
		}

		console.log('📋 Certificate files found:');
		console.log(`  ✅ Valid cert: ${serverCertPath}`);
		console.log(`  ✅ Revoked cert: ${revokedCertPath}`);
		console.log(`  ✅ CA cert: ${caCertPath}\n`);

		// Test 1: Valid certificate (should succeed)
		console.log('🧪 Test 1: Valid certificate (should be accepted)');
		const validResult = await makeSecureRequest(serverCertPath, serverKeyPath, caCertPath, 'operations');

		if (validResult.statusCode === 200) {
			console.log('  ✅ Valid certificate accepted - CRL verification passed\n');
		} else if (validResult.statusCode === 401 || validResult.statusCode === 403) {
			console.log('  ❌ Valid certificate rejected - CRL verification may have failed\n');
		} else if (validResult.error) {
			console.log(`  ⚠️  Connection error: ${validResult.error}\n`);
		}

		// Test 2: Revoked certificate (should fail)
		console.log('🧪 Test 2: Revoked certificate (should be rejected)');
		const revokedResult = await makeSecureRequest(revokedCertPath, revokedKeyPath, caCertPath, 'operations');

		if (revokedResult.statusCode === 401 || revokedResult.statusCode === 403) {
			console.log('  ✅ Revoked certificate rejected - CRL verification working correctly\n');
		} else if (revokedResult.statusCode === 200) {
			console.log('  ❌ Revoked certificate accepted - CRL verification may not be working\n');
		} else if (revokedResult.error) {
			console.log(`  ⚠️  Connection error: ${revokedResult.error}\n`);
		}

		// Test 3: Check REST endpoint as well
		console.log('🧪 Test 3: Valid certificate via REST endpoint');
		const restResult = await makeSecureRequest(serverCertPath, serverKeyPath, caCertPath, 'rest');

		if (restResult.statusCode === 200 || restResult.statusCode === 404) {
			console.log('  ✅ REST endpoint accessible with valid certificate\n');
		} else if (restResult.error) {
			console.log(`  ⚠️  REST connection error: ${restResult.error}\n`);
		}

		console.log('📋 Test Summary:');
		console.log('- If valid certificates are accepted and revoked certificates are rejected,');
		console.log('  then CRL verification is working correctly.');
		console.log('- If both are accepted, CRL verification may be disabled or not working.');
		console.log('- Connection errors may indicate Harper is not running with mTLS enabled.\n');

		console.log('💡 To verify Harper configuration:');
		console.log('1. Check harperdb-config.yaml has certificateVerification enabled under mtls');
		console.log('2. Ensure Harper is running on the expected secure ports');
		console.log('3. Check Harper logs for CRL verification debug messages');
	} catch (error) {
		console.error('❌ Test failed:', error);
		process.exit(1);
	}
}

testCRL();
