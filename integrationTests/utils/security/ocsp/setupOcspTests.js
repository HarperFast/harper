#!/usr/bin/env node

/**
 * Setup script for OCSP integration tests
 * This script helps prepare the environment for running OCSP certificate verification tests
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const certsPath = join(__dirname, 'generated');

async function runCommand(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		console.log(`Running: ${command} ${args.join(' ')}`);
		const proc = spawn(command, args, { stdio: 'inherit', ...options });
		proc.on('close', (code) => {
			if (code !== 0) {
				reject(new Error(`Command failed with code ${code}`));
			} else {
				resolve();
			}
		});
	});
}

async function generateCertificates() {
	console.log('Generating OCSP test certificates...');
	
	// Check if certificates already exist
	if (existsSync(join(certsPath, 'client-valid.crt'))) {
		console.log('Certificates already exist. Delete the generated/ directory to regenerate.');
		return;
	}
	
	// Run the certificate generation script
	await runCommand('node', ['generate-ocsp-certs.js'], { cwd: __dirname });
	
	console.log('Certificates generated successfully!');
}

async function updateHarperConfig() {
	console.log('\nUpdating Harper configuration for OCSP testing...');
	
	const configPath = join(process.cwd(), 'harperdb-config.yaml');
	if (!existsSync(configPath)) {
		console.error('harperdb-config.yaml not found. Please run this from the Harper root directory.');
		return;
	}
	
	console.log(`
To enable OCSP testing, add the following to your harperdb-config.yaml:

http:
  port: 9925
  https_port: 9926
  certificate: integrationTests/utils/security/ocsp/generated/server.crt
  certificate_key: integrationTests/utils/security/ocsp/generated/server.key
  mtls:
    enabled: true
    ca: integrationTests/utils/security/ocsp/generated/harper-ca.crt
    certificateVerification:
      timeout: 5000
      cacheTtl: 3600000
      failureMode: fail-open

mqtt:
  network:
    port: 8883
    certificate: integrationTests/utils/security/ocsp/generated/server.crt
    certificate_key: integrationTests/utils/security/ocsp/generated/server.key
    mtls:
      enabled: true
      ca: integrationTests/utils/security/ocsp/generated/harper-ca.crt
`);
}

async function main() {
	console.log('OCSP Integration Test Setup\n');
	
	try {
		// Generate certificates if needed
		await generateCertificates();
		
		// Show configuration instructions
		await updateHarperConfig();
		
		console.log('\nSetup complete! To run OCSP tests:');
		console.log('1. Update your harperdb-config.yaml with the configuration above');
		console.log('2. Start Harper with the updated configuration');
		console.log('3. Run: npm run test:integration -- --grep "OCSP"');
		console.log('\nNote: The integration tests will automatically start/stop the OCSP responder');
		
	} catch (error) {
		console.error('Setup failed:', error);
		process.exit(1);
	}
}

main();