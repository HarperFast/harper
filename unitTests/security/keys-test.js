'use strict';

require('../test_utils');
const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const fs = require('fs-extra');
const rewire = require('rewire');
const path = require('path');
const env_mgr = require('../../utility/environment/environmentManager');
const keys = rewire('../../security/keys');
const { generateSerialNumber } = require('../../security/keys');
const config_utils = require('../../config/configUtils');
const mkcert = require('mkcert');
const forge = require('node-forge');
const pki = forge.pki;

describe('Test keys module', () => {
	const sandbox = sinon.createSandbox();
	const test_dir = path.resolve(__dirname, '../envDir/keys-test');
	const test_cert_path = path.join(test_dir, 'test-certificate.pem');
	const test_ca_path = path.join(test_dir, 'test-ca.pem');
	const test_private_key_path = path.join(test_dir, 'test-private-key.pem');

	let update_config_value_stub;
	let test_private_key;
	let test_cert;
	let test_ca;
	let test_public_key;
	let actual_cert;
	let actual_ca;
	let root_path;

	before(async function () {
		this.timeout(10000);
		const ca = await mkcert.createCA({
			organization: 'Unit Test CA',
			countryCode: 'USA',
			state: 'Colorado',
			locality: 'Denver',
			validity: 1,
		});

		let cert = await mkcert.createCert({
			domains: ['Unit Test', '127.0.0.1', 'localhost', '::1'],
			validityDays: 1,
			caKey: ca.key,
			caCert: ca.cert,
		});

		test_private_key = cert.key;
		test_cert = cert.cert;
		test_ca = ca.cert;
		test_public_key = pki.certificateFromPem(ca.cert).publicKey;
		await fs.ensureDir(test_dir);
		await fs.writeFile(test_cert_path, test_cert);
		await fs.writeFile(test_private_key_path, test_private_key);
		await fs.writeFile(test_ca_path, test_ca);

		root_path = config_utils.getConfigFromFile('rootPath');
		env_mgr.setHdbBasePath(root_path);
		env_mgr.setProperty('storage_path', path.join(config_utils.getConfigFromFile('rootPath'), 'database'));

		await keys.loadCertificates();

		const all_certs = await keys.listCertificates();
		all_certs.forEach((cert) => {
			if (!cert.is_authority && cert?.details?.issuer?.includes('HarperDB-Certificate-Authority')) {
				actual_cert = cert;
			} else if (cert.name.includes('HarperDB-Certificate-Authority')) {
				actual_ca = cert;
			}
		});
	});

	afterEach(async () => {
		sandbox.restore();
		await fs.remove(test_dir);
	});

	it('Test loadCertificates loads certs from config file', async () => {
		// Load loadCertificates is called in the before method because other tests rely on it
		const all_certs = await keys.listCertificates();
		let private_key_pass = true;
		let cert_pass = false;
		let ca_pass = false;
		for (const cert of all_certs) {
			if (cert.certificate === test_private_key) {
				private_key_pass = false;
				break;
			}

			if (
				cert.name === actual_cert.name &&
				cert.certificate === actual_cert.certificate &&
				cert.private_key_name?.includes('privateKey.pem')
			)
				cert_pass = true;

			if (
				cert.name === actual_ca.name &&
				cert.certificate === actual_ca.certificate &&
				cert.private_key_name?.includes('privateKey.pem')
			)
				ca_pass = true;
		}

		expect(private_key_pass).to.be.true;
		expect(cert_pass).to.be.true;
		expect(ca_pass).to.be.true;
	});

	it('Test getReplicationCert returns the correct cert', async () => {
		env_mgr.setProperty('rootPath', root_path);
		const rep_cert = await keys.getReplicationCert();
		expect(rep_cert).to.exist;
		expect(rep_cert.name).to.equal(actual_cert.name);
		expect(rep_cert.issuer.includes('HarperDB-Certificate-Authority')).to.be.true;
	});

	it('Test getReplicationCertAuth returns the correct CA', async () => {
		const ca = await keys.getReplicationCertAuth();
		expect(ca.name).to.include('HarperDB-Certificate-Authority');
		expect(ca.certificate).to.equal(actual_ca.certificate);
	});

	it('Test createCsr happy path', async () => {
		const csr = await keys.createCsr();
		const csr_obj = pki.certificationRequestFromPem(csr);
		expect(csr).to.include('BEGIN CERTIFICATE REQUEST');
		expect(csr_obj.verify()).to.be.true;
	});

	it('Test signCertificate happy path', async () => {
		const signed_cert = await keys.signCertificate({ csr: await keys.createCsr() });
		const cert_obj = pki.certificateFromPem(signed_cert.certificate);
		expect(cert_obj.issuer.getField('CN').value).to.include('HarperDB-Certificate-Authority');
		expect(cert_obj.subject.getField('O').value).to.equal('HarperDB, Inc.');
		expect(signed_cert.signingCA).to.equal(actual_ca.certificate);
	});

	it('Test generateCertificates happy path', async () => {
		const generateCertificates = keys.__get__('generateCertificates');
		const cert = await generateCertificates(
			pki.privateKeyFromPem(test_private_key),
			test_public_key,
			pki.certificateFromPem(test_ca)
		);
		expect(cert).to.include('BEGIN CERTIFICATE');
	});

	it('Test getCertAuthority happy path', async () => {
		const getCertAuthority = keys.__get__('getCertAuthority');
		const key_and_cert = await getCertAuthority();
		expect(key_and_cert?.ca?.name).to.include('HarperDB-Certificate-Authority');
		expect(key_and_cert?.ca?.private_key_name).to.equal('privateKey.pem');
	});

	it('Test reviewSelfSignedCert create a new cert', async () => {
		const set_cert_stub = sandbox.stub(keys, 'setCertTable');
		const get_rep_rw = keys.__set__('getReplicationCert', sandbox.stub().resolves(undefined));
		const set_cert_rw = keys.__set__('setCertTable', set_cert_stub);
		await keys.reviewSelfSignedCert();
		expect(set_cert_stub.firstCall.args[0].certificate).to.include('BEGIN CERTIFICATE');
		get_rep_rw();
		set_cert_rw();
	});

	it('Test updateConfigCert builds new cert config correctly', () => {
		update_config_value_stub = sandbox.stub(config_utils, 'updateConfigValue');
		update_config_value_stub.resetHistory();
		process.argv.push('--TLS_PRIVATEKEY', 'hi/im/a/private_key.pem');
		keys.updateConfigCert('public/cert.pem', 'private/cert.pem', 'certificate/authority.pem');
		expect(update_config_value_stub.args[0][2]).to.eql({
			tls_privateKey: 'hi/im/a/private_key.pem',
		});

		const command = process.argv.indexOf('--TLS_PRIVATEKEY');
		const value = process.argv.indexOf('hi/im/a/private_key.pem');
		if (command > -1) process.argv.splice(command, 1);
		if (value > -1) process.argv.splice(value, 1);
	});

	it('Test addCertificate adds a cert and private key, listCertificates lists the certs then removeCertificate removes it', async () => {
		const test_cert_name = 'add-cert-test';
		await keys.addCertificate({
			name: test_cert_name,
			certificate: test_cert,
			is_authority: false,
			private_key: test_private_key,
		});

		let certs = await keys.listCertificates();
		let cert_found = false;
		for (let cert of certs) {
			if (
				cert.name === test_cert_name &&
				cert.certificate === test_cert &&
				cert.private_key_name.includes('add-cert-test.pem')
			)
				cert_found = true;
		}

		expect(cert_found).to.be.true;

		await keys.removeCertificate({ name: test_cert_name });
		certs = await keys.listCertificates();
		let cert_not_found = true;
		for (let cert of certs) {
			if (cert.name === test_cert_name) cert_not_found = false;
		}

		expect(cert_not_found).to.be.true;
	});

	it('hostnamesFromCert returns the correct hostnames', async () => {
		const test_cert = {
			subject: '',
			subjectAltName: 'DirName:"CN=test-1.name\\u002cO=1999710",' + ' DirName:CN=test-2.org,IP-Address:1.2.3.4',
		};
		const hostnames = keys.hostnamesFromCert(test_cert);
		// eslint-disable-next-line sonarjs/no-hardcoded-ip
		expect(hostnames).to.eql(['test-1.name', 'test-2.org', '1.2.3.4']);
		expect(keys.getPrimaryHostName(test_cert)).to.eql('test-1.name');
	});

	it('getPrimaryHostName with subject', async () => {
		const test_cert = {
			subject: 'CN=test-1.name',
			subjectAltName: 'DirName:"CN=test-different',
		};
		expect(keys.getPrimaryHostName(test_cert)).to.eql('test-1.name');
	});

	it('test get_key returns JWT and key', async () => {
		const jwt_private = await keys.getKey({ name: '.jwtPrivate', bypass_auth: true });
		expect(jwt_private).to.include('PRIVATE KEY');

		const jwt_public = await keys.getKey({ name: '.jwtPublic', bypass_auth: true });
		expect(jwt_public).to.include('PUBLIC KEY');

		const private_key = await keys.getKey({ name: 'privateKey.pem', bypass_auth: true });
		expect(private_key).to.include('RSA PRIVATE KEY');
	});

	it('test get_key handles a non-existent key correctly', async () => {
		let error;
		try {
			await keys.getKey({ name: 'imNotAKey.pem', bypass_auth: true });
		} catch (err) {
			error = err;
		}
		expect(error.message).to.equal('Key not found');
	});
	it('can extract the hostnames from a certificate', async () => {
		const cert = {
			subjectaltname: 'IP Address:127.0.0.1, DNS:localhost, IP Address:0:0:0:0:0:0:0:1',
			subject: { CN: '127.0.0.1', C: 'USA', ST: 'Colorado', L: 'Denver', O: 'HarperDB, Inc.' },
		};

		const hostnames = await keys.getHostnamesFromCertificate(cert);
		expect(hostnames).to.have.members(['127.0.0.1', 'localhost']);
	});

	/*	it('Test SNI with wildcards', async () => {
		let cert1 = await mkcert.createCert({
			domains: ['host-one.com', 'default'],
			validityDays: 3650,
			caKey: certificates_terms.CERTIFICATE_VALUES.key,
			caCert: certificates_terms.CERTIFICATE_VALUES.cert,
		});
		let cert2 = await mkcert.createCert({
			domains: ['*.test-domain.com', '*.test-subdomain.test-domain2.com'],
			validityDays: 3650,
			caKey: certificates_terms.CERTIFICATE_VALUES.key,
			caCert: certificates_terms.CERTIFICATE_VALUES.cert,
		});
		let SNICallback = createSNICallback([
			{
				certificate: cert1.cert,
				privateKey: cert1.key,
			},
			{
				certificate: cert2.cert,
				privateKey: cert2.key,
			},
		]);
		let context;
		SNICallback('host.test-domain.com', (err, ctx) => {
			context = ctx;
		});
		expect(context.options.cert).to.eql(cert2.cert);

		SNICallback('nomatch.com', (err, ctx) => {
			context = ctx;
		});
		expect(context.options.cert).to.eql(cert1.cert);

		SNICallback('host.test-subdomain.test-domain2.com', (err, ctx) => {
			context = ctx;
		});
		expect(context.options.cert).to.eql(cert2.cert);
	});*/

	it('Test setCertTable with malformed certificate - illegal ASN.1 padding', async () => {
		// Test various malformed certificate scenarios that could cause the X509Certificate error
		const malformedCerts = [
			// Certificate with corrupted base64 padding
			{
				name: 'corrupted-base64-padding',
				certificate: '-----BEGIN CERTIFICATE-----\nMIIEFzCCAv+gAwIBAgIUBg==\n-----END CERTIFICATE-----',
			},
			// Certificate with truncated data
			{
				name: 'truncated-cert',
				certificate: '-----BEGIN CERTIFICATE-----\nMIIEFzCCAv+gAwIBAgIU',
			},
			// Certificate with invalid characters
			{
				name: 'invalid-chars',
				certificate: '-----BEGIN CERTIFICATE-----\n!!!INVALID!!!DATA!!!\n-----END CERTIFICATE-----',
			},
			// Certificate missing end marker
			{
				name: 'missing-end-marker',
				certificate: '-----BEGIN CERTIFICATE-----\nMIIEFzCCAv+gAwIBAgIUBg==',
			},
			// Empty certificate data
			{
				name: 'empty-cert',
				certificate: '-----BEGIN CERTIFICATE-----\n\n-----END CERTIFICATE-----',
			},
			// Certificate with extra padding
			{
				name: 'extra-padding',
				certificate: '-----BEGIN CERTIFICATE-----\nMIIEFzCCAv+gAwIBAgIUBg====\n-----END CERTIFICATE-----',
			},
			// Certificate with illegal padding (specific case from CI error)
			{
				name: 'illegal-padding',
				certificate: '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHN\n-----END CERTIFICATE-----',
			},
			// Certificate with malformed ASN.1 structure
			{
				name: 'malformed-asn1',
				certificate:
					'-----BEGIN CERTIFICATE-----\nMIICEjCCAXsCAg36MA0GCSqGSIb3DQEBBQUAMIGbMQswCQYDVQQGEwJKUDEOMAwG\n-----END CERTIFICATE-----',
			},
			// Certificate with broken DER encoding
			{
				name: 'broken-der',
				certificate:
					'-----BEGIN CERTIFICATE-----\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END CERTIFICATE-----',
			},
		];

		for (const malformedCert of malformedCerts) {
			let error;
			try {
				await keys.setCertTable(malformedCert);
			} catch (err) {
				error = err;
			}

			expect(error).to.exist;
			// Now expecting our custom error code
			expect(error.code).to.equal('INVALID_CERTIFICATE_FORMAT');

			// Log the specific error for debugging
			// console.log(`Test case '${malformedCert.name}' error:`, error.code, error.message.substring(0, 80) + '...');
		}
	});

	describe('generateSerialNumber', () => {
		it('should generate valid hex serial numbers', () => {
			const serial = generateSerialNumber();
			expect(serial).to.be.a('string');
			expect(serial).to.match(/^[0-9a-f]{16}$/); // 16 hex chars (8 bytes)
		});

		it('should generate positive ASN.1 integers (high bit cleared)', () => {
			// Test multiple serials to ensure high bit is always cleared
			for (let i = 0; i < 100; i++) {
				const serial = generateSerialNumber();
				const firstByte = parseInt(serial.substring(0, 2), 16);
				expect(firstByte).to.be.lessThan(0x80); // High bit must be 0
			}
		});

		it('should generate unique serial numbers', () => {
			const serials = new Set();
			for (let i = 0; i < 1000; i++) {
				const serial = generateSerialNumber();
				expect(serials.has(serial)).to.be.false;
				serials.add(serial);
			}
		});
	});

	it('Test setCertTable with valid certificate should work', async () => {
		// Ensure a valid certificate still works
		const validCert = {
			name: 'valid-test-cert',
			certificate: test_cert,
			uses: ['https'],
			is_authority: false,
			private_key_name: 'test.pem',
		};

		// This should not throw
		await keys.setCertTable(validCert);

		// Verify it was added
		const certs = await keys.listCertificates();
		const found = certs.find((c) => c.name === 'valid-test-cert');
		expect(found).to.exist;

		// Clean up
		await keys.removeCertificate({ name: 'valid-test-cert' });
	});

	it('Test setCertTable error handling suggestion for cloneNode issue', async () => {
		// This test demonstrates the need for better error handling in setCertTable
		// The cloneNode CI error shows that certificates can be corrupted during transfer

		// Simulate what might happen during cloneNode with corrupted cert data
		const scenarios = [
			{
				name: 'cert-corrupted-during-transfer',
				certificate: test_cert.substring(0, test_cert.length - 100), // Truncated cert
			},
			{
				name: 'cert-with-wrong-line-endings',
				certificate: test_cert.replace(/\n/g, '\r'), // Wrong line endings
			},
			{
				name: 'cert-with-encoding-issues',
				certificate: Buffer.from(test_cert).toString('hex'), // Wrong encoding
			},
		];

		for (const scenario of scenarios) {
			let error;
			try {
				await keys.setCertTable(scenario);
			} catch (err) {
				error = err;
			}

			expect(error).to.exist;
			// console.log(`Scenario '${scenario.name}' error:`, error.message);

			// The error should be from X509Certificate constructor
			expect(error.message).to.match(/asn1|certificate|invalid|wrong|PEM|bad/i);
		}
	});

	it('Test generateCertAuthority includes subjectKeyIdentifier extension for OCSP support', async () => {
		// Get the private generateCertAuthority function
		const generateCertAuthority = keys.__get__('generateCertAuthority');
		const { privateKey, publicKey } = await keys.generateKeys();

		// Generate a CA certificate
		const caCert = await generateCertAuthority(privateKey, publicKey, false);

		// Verify the certificate has the required extensions
		const extensions = caCert.extensions;

		// Check that subjectKeyIdentifier extension is present
		const hasSubjectKeyIdentifier = extensions.some((ext) => ext.name === 'subjectKeyIdentifier');
		expect(hasSubjectKeyIdentifier).to.be.true;

		// Also verify other required extensions are still present
		const hasBasicConstraints = extensions.some((ext) => ext.name === 'basicConstraints' && ext.cA === true);
		const hasKeyUsage = extensions.some((ext) => ext.name === 'keyUsage' && ext.keyCertSign === true);

		expect(hasBasicConstraints).to.be.true;
		expect(hasKeyUsage).to.be.true;

		// Verify the extension count to ensure nothing was accidentally removed
		expect(extensions.length).to.equal(3);
	});
});
