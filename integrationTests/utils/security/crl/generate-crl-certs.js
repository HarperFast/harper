#!/usr/bin/env node

/**
 * Generate test certificates with CRL distribution points for CRL verification testing
 * This script creates a CA, server certificates, and CRL files for testing
 */

const { execSync } = require('node:child_process');
const { writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { getHarperCA } = require('../harperCA.js');

// Function to find Harper keys directory in common locations
function findHarperKeysDir() {
	const { homedir } = require('os');
	const possiblePaths = [
		// Local development path
		join(homedir(), 'hdb', 'keys'),
		// CI or different installation paths
		join(homedir(), '.harperdb', 'keys'),
		join(process.cwd(), '..', '..', '..', '..', 'keys'),
		join('/tmp', 'harperdb', 'keys'),
		join('/var', 'harperdb', 'keys'),
		// Check HARPERDB_ROOT env var if set
		...(process.env.HARPERDB_ROOT ? [join(process.env.HARPERDB_ROOT, 'keys')] : []),
	];

	for (const path of possiblePaths) {
		if (existsSync(path)) {
			console.log(`Found Harper keys directory at: ${path}`);
			return path;
		}
	}

	return null;
}

const CERTS_DIR = join(__dirname, 'generated');
const SCRIPT_DIR = __dirname;

// Configuration
const SERVER_SUBJECT = '/C=US/ST=CO/L=Denver/O=Harper Test/CN=localhost';
const CRL_SERVER_PORT = 8889;
const CRL_URL = `http://localhost:${CRL_SERVER_PORT}/test.crl`;

function ensureDirectory() {
	if (!existsSync(CERTS_DIR)) {
		mkdirSync(CERTS_DIR, { recursive: true });
	}
}

function runOpenSSL(args, options = {}) {
	const cmd = `openssl ${args.join(' ')}`;
	console.log(`Running: ${cmd}`);
	return execSync(cmd, { cwd: CERTS_DIR, encoding: 'utf8', ...options });
}

async function setupHarperCA() {
	console.log('Setting up Harper CA for CRL testing...');

	// Get Harper's CA from database
	const ca = await getHarperCA();

	// Save CA certificate for convenience
	const caCertPath = join(CERTS_DIR, 'harper-ca.crt');
	writeFileSync(caCertPath, ca.certificate);
	console.log(`CA certificate saved to: ${caCertPath}`);

	// Find CA private key in Harper's keys directory
	const harperKeysDir = findHarperKeysDir();
	if (!harperKeysDir) {
		console.error('\nERROR: Harper keys directory not found');
		console.error('Tried the following locations:');
		console.error('- ~/hdb/keys');
		console.error('- ~/.harperdb/keys');
		console.error('- /tmp/harperdb/keys');
		console.error('- /var/harperdb/keys');
		if (process.env.HARPERDB_ROOT) {
			console.error(`- ${process.env.HARPERDB_ROOT}/keys`);
		}
		throw new Error('Harper keys directory not found');
	}

	const caKeyPath = join(harperKeysDir, ca.private_key_name);
	if (!existsSync(caKeyPath)) {
		console.error(`\nERROR: CA private key not found at: ${caKeyPath}`);
		console.error("Please check the path to Harper's keys directory");
		console.error(`Expected Harper keys directory: ${harperKeysDir}`);
		throw new Error('CA private key not found');
	}

	console.log(`Using CA private key from: ${caKeyPath}`);

	return { ca, caCertPath, caKeyPath };
}

function generateServerCertificate(filename = 'server', caKeyPath) {
	console.log(`Generating ${filename} private key...`);
	runOpenSSL(['genpkey', '-algorithm', 'Ed25519', '-out', `${filename}.key`]);

	console.log(`Creating ${filename} certificate signing request...`);
	runOpenSSL(['req', '-new', '-key', `${filename}.key`, '-out', `${filename}.csr`, '-subj', `"${SERVER_SUBJECT}"`]);

	// Create extensions file with CRL distribution point
	const extensionsContent = `[v3_req]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
subjectAltName = @alt_names
crlDistributionPoints = @crl_section

[alt_names]
DNS.1 = localhost
DNS.2 = 127.0.0.1
IP.1 = 127.0.0.1
IP.2 = ::1

[crl_section]
URI.0 = ${CRL_URL}
`;

	writeFileSync(join(CERTS_DIR, `${filename}.ext`), extensionsContent);

	console.log(`Signing ${filename} certificate with Harper CA using CA database...`);
	runOpenSSL([
		'ca',
		'-in',
		`${filename}.csr`,
		'-cert',
		'harper-ca.crt',
		'-keyfile',
		caKeyPath,
		'-out',
		`${filename}.crt`,
		'-days',
		'365',
		'-extensions',
		'v3_req',
		'-extfile',
		`${filename}.ext`,
		'-config',
		'ca.conf',
		'-batch', // Don't prompt for confirmation
	]);

	// Create certificate chain
	console.log(`Creating ${filename} certificate chain...`);
	execSync(`cat ${filename}.crt harper-ca.crt > ${filename}-chain.crt`, { cwd: CERTS_DIR });
}

function generateRevokedCertificate(caKeyPath) {
	console.log('Generating revoked certificate...');
	// Use a different CN to avoid duplicate subject error
	const REVOKED_SUBJECT = '/C=US/ST=CO/L=Denver/O=Harper Test/CN=revoked-client';

	console.log('Generating revoked private key...');
	runOpenSSL(['genpkey', '-algorithm', 'Ed25519', '-out', 'revoked.key']);

	console.log('Creating revoked certificate signing request...');
	runOpenSSL(['req', '-new', '-key', 'revoked.key', '-out', 'revoked.csr', '-subj', `"${REVOKED_SUBJECT}"`]);

	// Create extensions file with CRL distribution point
	const extensionsContent = `[v3_req]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
subjectAltName = @alt_names
crlDistributionPoints = @crl_section

[alt_names]
DNS.1 = localhost
DNS.2 = 127.0.0.1
IP.1 = 127.0.0.1
IP.2 = ::1

[crl_section]
URI.0 = ${CRL_URL}
`;

	writeFileSync(join(CERTS_DIR, 'revoked.ext'), extensionsContent);

	console.log('Signing revoked certificate with Harper CA using CA database...');
	runOpenSSL([
		'ca',
		'-in',
		'revoked.csr',
		'-cert',
		'harper-ca.crt',
		'-keyfile',
		caKeyPath,
		'-out',
		'revoked.crt',
		'-days',
		'365',
		'-extensions',
		'v3_req',
		'-extfile',
		'revoked.ext',
		'-config',
		'ca.conf',
		'-batch', // Don't prompt for confirmation
	]);

	// Create certificate chain
	console.log('Creating revoked certificate chain...');
	execSync(`cat revoked.crt harper-ca.crt > revoked-chain.crt`, { cwd: CERTS_DIR });
}

function generateCRL() {
	console.log('Generating CRL with revoked certificates...');

	// Create initial empty CRL
	console.log('Generating initial empty CRL...');
	runOpenSSL(['ca', '-config', 'ca.conf', '-gencrl', '-out', 'test.crl']);

	// Sign the revoked certificate with CA to add it to database, then revoke it
	console.log('Adding revoked certificate to CA database...');
	try {
		// Re-sign the revoked certificate to add it to the CA database
		runOpenSSL([
			'ca',
			'-config',
			'ca.conf',
			'-in',
			'revoked.csr',
			'-out',
			'revoked-signed.crt',
			'-extensions',
			'v3_req',
			'-extfile',
			'revoked.ext',
			'-batch',
		]);

		// Now revoke it
		console.log('Revoking certificate...');
		runOpenSSL(['ca', '-config', 'ca.conf', '-revoke', 'revoked-signed.crt']);
	} catch (error) {
		console.log('Error during certificate revocation process:', error.message);
		// Continue anyway - we can still generate a CRL
	}

	// Generate CRL with revoked certificate
	console.log('Generating CRL with revoked certificate...');
	runOpenSSL(['ca', '-config', 'ca.conf', '-gencrl', '-out', 'test.crl']);

	// Verify CRL format
	console.log('Verifying CRL...');
	runOpenSSL(['crl', '-in', 'test.crl', '-text', '-noout']);
	console.log('CRL generated successfully');

	// Convert to PEM format (ensure it's in PEM)
	runOpenSSL(['crl', '-in', 'test.crl', '-out', 'test-pem.crl', '-outform', 'PEM']);
}

function createCRLServer() {
	console.log('Creating CRL server script...');
	const serverScript = `#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = ${CRL_SERVER_PORT};
const CRL_FILE = path.join(__dirname, 'generated', 'test.crl');

const server = http.createServer((req, res) => {
	console.log(\`CRL Server: \${req.method} \${req.url}\`);
	
	if (req.url === '/test.crl') {
		try {
			const crlData = fs.readFileSync(CRL_FILE);
			res.writeHead(200, {
				'Content-Type': 'application/pkix-crl',
				'Content-Length': crlData.length,
			});
			res.end(crlData);
		} catch (error) {
			console.error('Error serving CRL:', error);
			res.writeHead(404);
			res.end('CRL not found');
		}
	} else if (req.url === '/health') {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end('CRL Server OK');
	} else {
		res.writeHead(404);
		res.end('Not found');
	}
});

server.listen(PORT, () => {
	console.log(\`CRL server listening on port \${PORT}\`);
	console.log(\`CRL URL: http://localhost:\${PORT}/test.crl\`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
	console.log('Shutting down CRL server...');
	server.close(() => {
		process.exit(0);
	});
});

process.on('SIGINT', () => {
	console.log('Shutting down CRL server...');
	server.close(() => {
		process.exit(0);
	});
});
`;

	writeFileSync(join(SCRIPT_DIR, 'start-crl-server.js'), serverScript);
}

function createTestScript() {
	console.log('Creating test script...');
	const testScript = `#!/usr/bin/env node

/**
 * Test CRL verification manually
 */

const { verifyCRL } = require('../../../security/certificateVerification/index.ts');
const { readFileSync } = require('fs');
const { join } = require('path');

async function testCRL() {
	const certsDir = join(__dirname, 'generated');
	
	try {
		console.log('Testing CRL verification...');
		
		// Test with valid certificate (should be good)
		console.log('\\n1. Testing valid certificate...');
		const validCert = readFileSync(join(certsDir, 'server.crt'), 'utf8');
		const caCert = readFileSync(join(certsDir, 'ca.crt'), 'utf8');
		
		const validResult = await verifyCRL(validCert, caCert, {
			timeout: 5000,
			failureMode: 'fail-open'
		});
		console.log('Valid certificate result:', validResult);
		
		// Test with revoked certificate (should be revoked)
		console.log('\\n2. Testing revoked certificate...');
		const revokedCert = readFileSync(join(certsDir, 'revoked.crt'), 'utf8');
		
		const revokedResult = await verifyCRL(revokedCert, caCert, {
			timeout: 5000,
			failureMode: 'fail-open'
		});
		console.log('Revoked certificate result:', revokedResult);
		
		console.log('\\nCRL verification test completed.');
	} catch (error) {
		console.error('Test failed:', error);
		process.exit(1);
	}
}

testCRL();
`;

	writeFileSync(join(SCRIPT_DIR, 'test-crl-manual.js'), testScript);
}

function createSetupScript() {
	console.log('Creating setup script...');
	const setupScript = `#!/bin/bash

# Setup script for CRL testing
set -e

echo "Setting up CRL test environment..."

# Generate certificates and CRL
node generate-crl-certs.js

echo "CRL test environment setup complete."
echo ""
echo "Next steps:"
echo "1. Start the CRL server: node start-crl-server.js"
echo "2. In another terminal, run manual test: node test-crl-manual.js"
echo "3. Or run the full integration test suite"
`;

	writeFileSync(join(SCRIPT_DIR, 'setup-crl-test.sh'), setupScript);
}

function createCAConfiguration(caKeyPath) {
	console.log('Creating OpenSSL CA configuration...');
	// Create CRL database files
	writeFileSync(join(CERTS_DIR, 'crlnumber'), '1000\n');
	writeFileSync(join(CERTS_DIR, 'index.txt'), '');
	writeFileSync(join(CERTS_DIR, 'serial'), '1000\n');

	// Create OpenSSL CA configuration
	const caConfig = `[ca]
default_ca = CA_default

[CA_default]
dir               = ${CERTS_DIR}
certs             = ${CERTS_DIR}
crl_dir           = ${CERTS_DIR}
database          = ${CERTS_DIR}/index.txt
new_certs_dir     = ${CERTS_DIR}
certificate       = ${CERTS_DIR}/harper-ca.crt
serial            = ${CERTS_DIR}/serial
crlnumber         = ${CERTS_DIR}/crlnumber
crl               = ${CERTS_DIR}/test.crl
private_key       = ${caKeyPath}
RANDFILE          = ${CERTS_DIR}/.rand
default_days      = 365
default_crl_days  = 30
default_md        = sha256
preserve          = no
policy            = policy_loose

[policy_loose]
countryName             = optional
stateOrProvinceName     = optional
localityName            = optional
organizationName        = optional
organizationalUnitName  = optional
commonName              = supplied
emailAddress            = optional

[v3_req]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
subjectAltName = @alt_names
crlDistributionPoints = @crl_section

[alt_names]
DNS.1 = localhost
DNS.2 = 127.0.0.1
IP.1 = 127.0.0.1
IP.2 = ::1

[crl_section]
URI.0 = ${CRL_URL}

[crl_ext]
# CRL extensions
authorityKeyIdentifier=keyid:always
`;

	writeFileSync(join(CERTS_DIR, 'ca.conf'), caConfig);
}

async function main() {
	console.log('Starting CRL test certificate generation using Harper CA...');

	try {
		ensureDirectory();

		// Get Harper's CA and set up certificates
		const { caKeyPath } = await setupHarperCA();

		// Create CA configuration first (needed for certificate generation)
		createCAConfiguration(caKeyPath);

		// Generate test certificates using Harper's CA
		generateServerCertificate('server', caKeyPath);
		generateRevokedCertificate(caKeyPath);
		generateCRL();

		// Create supporting scripts
		createCRLServer();
		createTestScript();
		createSetupScript();

		console.log('\\nCRL test environment created successfully!');
		console.log('\\nGenerated files:');
		console.log('- Harper CA certificate: generated/harper-ca.crt');
		console.log('- Server certificate: generated/server.crt');
		console.log('- Revoked certificate: generated/revoked.crt');
		console.log('- CRL file: generated/test.crl');
		console.log('\\nNext steps:');
		console.log('1. Start CRL server: node start-crl-server.js');
		console.log('2. Run manual test: node test-crl-manual.js');
		console.log("\\nNote: Certificates are signed by Harper's CA, so they should be trusted automatically.");
	} catch (error) {
		console.error('\\nError generating CRL test certificates:', error.message);
		console.error('Make sure Harper is running and accessible at the configured URL.');
		process.exit(1);
	}
}

if (require.main === module) {
	main();
}
