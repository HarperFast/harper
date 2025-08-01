#!/usr/bin/env node

/**
 * Manual OCSP Certificate Verification Test
 * 
 * This test uses Ed25519 certificates to verify OCSP functionality.
 * The PKI.js patch supports both Ed25519 and Ed448 algorithms.
 * 
 * Requirements:
 * - Harper must be configured with mTLS and certificate verification
 * - OCSP responder must be running on port 8888 (run start-ocsp.sh)
 */

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

console.log('=== OCSP Certificate Verification Test (Ed25519) ===\n');
console.log('NOTE: This test requires Harper to be configured with mTLS and certificate verification.');
console.log('The test CA must be trusted by Harper.\n');

async function testCertificate(certFile, keyFile, expectedStatus, description) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'localhost',
      port: 9953,
      path: '/',
      method: 'GET',
      cert: fs.readFileSync(path.join(__dirname, 'generated', certFile)),
      key: fs.readFileSync(path.join(__dirname, 'generated', keyFile)),
      ca: fs.readFileSync(path.join(__dirname, 'generated', 'harper-ca.crt')),
      rejectUnauthorized: false
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === expectedStatus) {
        console.log(`✓ ${description}: HTTP ${res.statusCode}`);
      } else {
        console.log(`✗ ${description}: HTTP ${res.statusCode} (expected ${expectedStatus})`);
      }
      resolve();
    });

    req.on('error', (e) => {
      console.error(`✗ ${description}: ${e.message}`);
      if (e.message.includes('SELF_SIGNED_CERT_IN_CHAIN')) {
        console.log('  → Harper rejected the test CA. Add generated/harper-ca.crt to Harper\'s trusted CAs.');
      }
      resolve();
    });

    req.end();
  });
}

async function runTests() {
  // Test valid certificate
  await testCertificate('client-valid-chain.crt', 'client-valid.key', 404, 'Valid certificate');
  
  // Test revoked certificate
  await testCertificate('client-revoked-chain.crt', 'client-revoked.key', 401, 'Revoked certificate');
  
  console.log('\nCheck logs: tail -f ~/hdb/log/hdb.log | grep cert-verification');
}

// Run tests directly
// Note: The OCSP responder must be running on port 8888
// Start it with: bash start-ocsp.sh
runTests();