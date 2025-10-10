#!/usr/bin/env node

/**
 * Generate test certificates for OCSP testing using Harper's existing CA
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { getHarperCA } = require('../harperCA.js');

// Function to find Harper keys directory in common locations
function findHarperKeysDir() {
	const { homedir } = require('os');
	const possiblePaths = [
		// Local development path
		path.join(homedir(), 'hdb', 'keys'),
		// CI or different installation paths
		path.join(homedir(), '.harperdb', 'keys'),
		path.join(process.cwd(), '..', '..', '..', '..', 'keys'),
		path.join('/tmp', 'harperdb', 'keys'),
		path.join('/var', 'harperdb', 'keys'),
		// Check HARPERDB_ROOT env var if set
		...(process.env.HARPERDB_ROOT ? [path.join(process.env.HARPERDB_ROOT, 'keys')] : []),
	];

	for (const keyPath of possiblePaths) {
		if (fs.existsSync(keyPath)) {
			console.log(`Found Harper keys directory at: ${keyPath}`);
			return keyPath;
		}
	}

	return null;
}

const OUTPUT_DIR = path.join(__dirname, 'generated');
const OCSP_PORT = process.env.OCSP_PORT || 8888;

async function generateOCSPCerts() {
	// Create output directory
	if (!fs.existsSync(OUTPUT_DIR)) {
		fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	}

	try {
		// Step 1: Get Harper's CA
		const ca = await getHarperCA();

		// Save CA certificate for convenience
		const caCertPath = path.join(OUTPUT_DIR, 'harper-ca.crt');
		fs.writeFileSync(caCertPath, ca.certificate);
		console.log(`\nCA certificate saved to: ${caCertPath}`);

		// Step 2: Find CA private key
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

		const caKeyPath = path.join(harperKeysDir, ca.private_key_name);
		if (!fs.existsSync(caKeyPath)) {
			console.error(`\nERROR: CA private key not found at: ${caKeyPath}`);
			console.error("Please check the path to Harper's keys directory");
			console.error(`Expected Harper keys directory: ${harperKeysDir}`);
			return;
		}

		console.log(`Using CA private key from: ${caKeyPath}`);

		// Step 3: Generate OCSP responder certificate
		console.log('\nGenerating OCSP responder certificate...');
		const ocspKeyPath = path.join(OUTPUT_DIR, 'ocsp.key');
		const ocspCertPath = path.join(OUTPUT_DIR, 'ocsp.crt');

		execSync(`openssl genpkey -algorithm ED25519 -out ${ocspKeyPath}`);
		execSync(
			`openssl req -new -key ${ocspKeyPath} -out ${OUTPUT_DIR}/ocsp.csr -subj "/CN=OCSP Responder/O=Harper OCSP Test"`
		);

		// OCSP responder extensions
		const ocspExt = `[v3_ocsp]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
extendedKeyUsage = OCSPSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer`;

		fs.writeFileSync(path.join(OUTPUT_DIR, 'ocsp.ext'), ocspExt);

		execSync(
			`openssl x509 -req -in ${OUTPUT_DIR}/ocsp.csr -CA ${caCertPath} -CAkey ${caKeyPath} -CAcreateserial -out ${ocspCertPath} -days 365 -extensions v3_ocsp -extfile ${OUTPUT_DIR}/ocsp.ext`
		);
		console.log('OCSP responder certificate created');

		// Step 4: Generate server certificate for Harper
		console.log('\nGenerating server certificate...');
		const serverKeyPath = path.join(OUTPUT_DIR, 'server.key');
		const serverCertPath = path.join(OUTPUT_DIR, 'server.crt');

		execSync(`openssl genpkey -algorithm ED25519 -out ${serverKeyPath}`);

		// Server extensions with OCSP URL and CA issuer URL
		const serverExt = `[v3_server]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
authorityInfoAccess = OCSP;URI:http://localhost:${OCSP_PORT},caIssuers;URI:http://localhost:${OCSP_PORT}/ca.crt`;
		fs.writeFileSync(path.join(OUTPUT_DIR, 'server.ext'), serverExt);

		execSync(
			`openssl req -new -key ${serverKeyPath} -out ${OUTPUT_DIR}/server.csr -subj "/CN=localhost/O=Harper OCSP Test"`
		);
		execSync(
			`openssl x509 -req -in ${OUTPUT_DIR}/server.csr -CA ${caCertPath} -CAkey ${caKeyPath} -CAcreateserial -out ${serverCertPath} -days 365 -extensions v3_server -extfile ${OUTPUT_DIR}/server.ext`
		);
		console.log('Server certificate created');

		// Step 5: Generate client certificates with OCSP URLs
		const clients = [
			{ name: 'client-valid', cn: 'Valid Test Client' },
			{ name: 'client-revoked', cn: 'Revoked Test Client' },
		];

		for (const client of clients) {
			console.log(`\nGenerating ${client.name}...`);
			const keyPath = path.join(OUTPUT_DIR, `${client.name}.key`);
			const certPath = path.join(OUTPUT_DIR, `${client.name}.crt`);

			execSync(`openssl genpkey -algorithm ED25519 -out ${keyPath}`);

			// Client extensions with OCSP URL and CA issuer URL
			const clientExt = `[v3_client]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
authorityInfoAccess = OCSP;URI:http://localhost:${OCSP_PORT},caIssuers;URI:http://localhost:${OCSP_PORT}/ca.crt`;
			fs.writeFileSync(path.join(OUTPUT_DIR, `${client.name}.ext`), clientExt);

			execSync(
				`openssl req -new -key ${keyPath} -out ${OUTPUT_DIR}/${client.name}.csr -subj "/CN=${client.cn}/O=Harper OCSP Test"`
			);
			execSync(
				`openssl x509 -req -in ${OUTPUT_DIR}/${client.name}.csr -CA ${caCertPath} -CAkey ${caKeyPath} -CAcreateserial -out ${certPath} -days 365 -extensions v3_client -extfile ${OUTPUT_DIR}/${client.name}.ext`
			);

			console.log(`${client.name} created`);
		}

		// Step 5: Create certificate chains
		console.log('\nCreating certificate chains...');
		for (const client of clients) {
			const certPath = path.join(OUTPUT_DIR, `${client.name}.crt`);
			const chainPath = path.join(OUTPUT_DIR, `${client.name}-chain.crt`);
			const certContent = fs.readFileSync(certPath, 'utf8');
			const caContent = fs.readFileSync(caCertPath, 'utf8');
			fs.writeFileSync(chainPath, certContent + caContent);
			console.log(`Created ${client.name}-chain.crt`);
		}

		// Also create OCSP chain
		const ocspChainPath = path.join(OUTPUT_DIR, 'ocsp-chain.crt');
		const ocspContent = fs.readFileSync(ocspCertPath, 'utf8');
		fs.writeFileSync(ocspChainPath, ocspContent + fs.readFileSync(caCertPath, 'utf8'));
		console.log('Created ocsp-chain.crt');

		// Step 6: Create OCSP database
		console.log('\nCreating OCSP database...');
		const indexPath = path.join(OUTPUT_DIR, 'index.txt');
		const serialPath = path.join(OUTPUT_DIR, 'serial');

		fs.writeFileSync(indexPath, '');
		fs.writeFileSync(serialPath, '01\n');

		// Add certificate entries to index
		const { X509Certificate } = require('node:crypto');
		const validCert = new X509Certificate(fs.readFileSync(path.join(OUTPUT_DIR, 'client-valid.crt')));
		const revokedCert = new X509Certificate(fs.readFileSync(path.join(OUTPUT_DIR, 'client-revoked.crt')));

		// Format dates for OpenSSL index.txt (YYYYMMDDHHmmssZ format for validity, YYMMDDHHmmssZ for revocation)
		const now = new Date();
		const validFrom = now.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
		const revocationDate = now.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';

		// Format subject DN for OpenSSL index file (replace newlines with /)
		const validSubject = validCert.subject.replace(/\n/g, '/');
		const revokedSubject = revokedCert.subject.replace(/\n/g, '/');

		// Valid certificate entry (V status, empty revocation date)
		fs.appendFileSync(indexPath, `V\t${validFrom}\t\t${validCert.serialNumber}\tunknown\t${validSubject}\n`);

		// Revoked certificate entry (R status, includes revocation date)
		fs.appendFileSync(
			indexPath,
			`R\t${validFrom}\t${revocationDate}\t${revokedCert.serialNumber}\tunknown\t${revokedSubject}\n`
		);

		// Step 7: Display completion message

		console.log('\n=== Certificate Generation Complete! ===\n');
		console.log('Generated files in:', OUTPUT_DIR);
		console.log("- harper-ca.crt              : Harper's CA certificate");
		console.log('- server.crt/key             : Harper server certificate');
		console.log('- ocsp.crt/key               : OCSP responder certificate');
		console.log('- ocsp-chain.crt             : OCSP certificate chain');
		console.log('- client-valid.crt/key       : Valid client certificate');
		console.log('- client-valid-chain.crt     : Valid client certificate chain');
		console.log('- client-revoked.crt/key     : Revoked client certificate');
		console.log('- client-revoked-chain.crt   : Revoked client certificate chain');
		console.log('- index.txt                  : OCSP database\n');
	} catch (error) {
		console.error('Error:', error.message);
	}
}

// Run the script
generateOCSPCerts().catch(console.error);
