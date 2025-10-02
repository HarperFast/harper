#!/usr/bin/env node

/**
 * Generate test certificates for OCSP integration testing
 * This script generates a complete test CA and certificates for OCSP testing
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const OUTPUT_DIR = path.join(__dirname, 'generated');
const OCSP_PORT = process.env.OCSP_PORT || 8888;
const OCSP_HOST = process.env.OCSP_HOST || 'localhost';

function generateTestCA() {
	console.log('Generating test CA for OCSP testing...');

	const caKeyPath = path.join(OUTPUT_DIR, 'harper-ca.key');
	const caCertPath = path.join(OUTPUT_DIR, 'harper-ca.crt');

	// Generate CA key
	execSync(`openssl genpkey -algorithm ED25519 -out ${caKeyPath}`);

	// Generate CA certificate
	execSync(
		`openssl req -new -x509 -key ${caKeyPath} -out ${caCertPath} -days 365 -subj "/CN=Harper Test CA/O=Harper OCSP Test"`
	);

	console.log('Test CA generated successfully');
	return { caKeyPath, caCertPath };
}

function generateOCSPCerts() {
	// Create output directory
	if (!fs.existsSync(OUTPUT_DIR)) {
		fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	}

	try {
		// Generate test CA
		const { caKeyPath, caCertPath } = generateTestCA();

		// Generate OCSP responder certificate
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

		// Create OCSP chain
		execSync(`cat ${ocspCertPath} ${caCertPath} > ${OUTPUT_DIR}/ocsp-chain.crt`);

		// Generate client certificates
		console.log('\nGenerating client certificates...');

		// Valid client certificate
		const validKeyPath = path.join(OUTPUT_DIR, 'client-valid.key');
		const validCertPath = path.join(OUTPUT_DIR, 'client-valid.crt');

		execSync(`openssl genpkey -algorithm ED25519 -out ${validKeyPath}`);

		const clientExt = `[v3_client]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
subjectAltName = DNS:client.local
authorityInfoAccess = OCSP;URI:http://${OCSP_HOST}:${OCSP_PORT},caIssuers;URI:http://${OCSP_HOST}:${OCSP_PORT}/ca.crt`;

		fs.writeFileSync(path.join(OUTPUT_DIR, 'client.ext'), clientExt);

		execSync(
			`openssl req -new -key ${validKeyPath} -out ${OUTPUT_DIR}/client-valid.csr -subj "/CN=Valid Client/O=Harper OCSP Test"`
		);
		execSync(
			`openssl x509 -req -in ${OUTPUT_DIR}/client-valid.csr -CA ${caCertPath} -CAkey ${caKeyPath} -CAcreateserial -out ${validCertPath} -days 365 -extensions v3_client -extfile ${OUTPUT_DIR}/client.ext`
		);

		// Create chain for valid cert
		execSync(`cat ${validCertPath} ${caCertPath} > ${OUTPUT_DIR}/client-valid-chain.crt`);

		// Revoked client certificate
		const revokedKeyPath = path.join(OUTPUT_DIR, 'client-revoked.key');
		const revokedCertPath = path.join(OUTPUT_DIR, 'client-revoked.crt');

		execSync(`openssl genpkey -algorithm ED25519 -out ${revokedKeyPath}`);
		execSync(
			`openssl req -new -key ${revokedKeyPath} -out ${OUTPUT_DIR}/client-revoked.csr -subj "/CN=Revoked Client/O=Harper OCSP Test"`
		);
		execSync(
			`openssl x509 -req -in ${OUTPUT_DIR}/client-revoked.csr -CA ${caCertPath} -CAkey ${caKeyPath} -CAcreateserial -out ${revokedCertPath} -days 365 -extensions v3_client -extfile ${OUTPUT_DIR}/client.ext`
		);

		// Create chain for revoked cert
		execSync(`cat ${revokedCertPath} ${caCertPath} > ${OUTPUT_DIR}/client-revoked-chain.crt`);

		console.log('Client certificates created');

		// Create OCSP database
		console.log('\nSetting up OCSP database...');

		// Create index file
		const validSerial = execSync(`openssl x509 -in ${validCertPath} -noout -serial`).toString().trim().split('=')[1];
		const revokedSerial = execSync(`openssl x509 -in ${revokedCertPath} -noout -serial`)
			.toString()
			.trim()
			.split('=')[1];

		const indexContent = `V\t${new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().replace(/[-:]/g, '').slice(0, -5)}Z\t\t${validSerial}\tunknown\t/CN=Valid Client/O=Harper OCSP Test
R\t${new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().replace(/[-:]/g, '').slice(0, -5)}Z\t${new Date().toISOString().replace(/[-:]/g, '').slice(0, -5)}Z\t${revokedSerial}\tunknown\t/CN=Revoked Client/O=Harper OCSP Test`;

		fs.writeFileSync(path.join(OUTPUT_DIR, 'index.txt'), indexContent);
		fs.writeFileSync(path.join(OUTPUT_DIR, 'index.txt.attr'), 'unique_subject = no\n');

		console.log('\nAll certificates generated successfully!');
		console.log(`Output directory: ${OUTPUT_DIR}`);
	} catch (error) {
		console.error('Error generating certificates:', error.message);
		process.exit(1);
	}
}

// Run the generation
generateOCSPCerts();
