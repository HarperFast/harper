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
const config_utils = require('../../config/configUtils');
const certificates_terms = require('../../utility/terms/certificates');
const mkcert = require('mkcert');
const forge = require('node-forge');
const pki = forge.pki;
const { X509Certificate, createPrivateKey, createPublicKey } = require('crypto');
const { createSNICallback } = require('../../server/threads/threadServer');

describe('Test keys module', () => {
	const sandbox = sinon.createSandbox();
	const test_dir = path.resolve(__dirname, '../envDir/keys-test');
	const test_cert_path = path.join(test_dir, 'test-certificate.pem');
	const test_ca_path = path.join(test_dir, 'test-ca.pem');
	const test_private_key_path = path.join(test_dir, 'test-private-key.pem');

	let write_file_stub;
	let console_error_stub;
	let update_config_value_stub;
	let get_config_from_file_stub;
	let test_private_key;
	let test_cert;
	let test_ca;
	let test_public_key;

	before(async () => {
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

		get_config_from_file_stub = sandbox.stub(config_utils, 'getConfigFromFile').returns({
			privateKey: test_private_key_path,
			certificate: test_cert_path,
			certificateAuthority: test_ca_path,
		});
		await keys.loadCertificates();
	});

	beforeEach(() => {
		// sandbox.stub(env_mgr, 'getHdbBasePath').returns('keys_test');
		// console_error_stub = sandbox.stub(console, 'error');
		// write_file_stub = sandbox.stub(fs, 'writeFile');
		// update_config_value_stub = sandbox.stub(config_utils, 'updateConfigValue');
	});

	afterEach(() => {
		sandbox.restore();
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
				cert.name === 'Unit Test' &&
				cert.certificate === test_cert &&
				cert.private_key_name?.includes('test-private-key.pem')
			)
				cert_pass = true;

			if (
				cert.name === 'Unit Test CA' &&
				cert.certificate === test_ca &&
				cert.private_key_name?.includes('test-private-key.pem')
			)
				ca_pass = true;
		}

		expect(private_key_pass).to.be.true;
		expect(cert_pass).to.be.true;
		expect(ca_pass).to.be.true;
	});

	it('Test getReplicationCert returns the correct cert', async () => {
		const rep_cert = await keys.getReplicationCert();
		expect(rep_cert.name).to.equal('Unit Test');
		expect(rep_cert.options.cert).to.equal(test_cert);
		expect(rep_cert.issuer.includes('Unit Test CA')).to.be.true;
	});

	it('Test getReplicationCertAuth returns the correct CA', async () => {
		const ca = await keys.getReplicationCertAuth();
		expect(ca.name).to.equal('Unit Test CA');
		expect(ca.certificate).to.equal(test_ca);
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
		const x509 = new X509Certificate(signed_cert.certificate);
		expect(x509.checkPrivateKey(createPrivateKey(test_private_key))).to.be.true;
		expect(cert_obj.issuer.getField('CN').value).to.equal('Unit Test CA');
		expect(cert_obj.subject.getField('O').value).to.equal('HarperDB, Inc.');
		expect(signed_cert.ca_certificate).to.equal(test_ca);
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

	it('Test getHDBCertAuthority happy path', async () => {
		const getHDBCertAuthority = keys.__get__('getHDBCertAuthority');
		const ca = await getHDBCertAuthority();
		expect(ca.name).to.include('HarperDB-Certificate-Authority');
		expect(ca.private_key_name).to.equal('privateKey.pem');
	});

	it('Test writeDefaultCertsToFile writes public and CA to file', () => {});

	it('Test updateConfigCert builds new cert config correctly', () => {
		process.env['CLUSTERING_TLS_CERTIFICATEAUTHORITY'] = 'howdy/im/a/ca.pem';
		process.argv.push('--TLS_PRIVATEKEY', 'hi/im/a/private_key.pem');
		keys.updateConfigCert('public/cert.pem', 'private/cert.pem', 'certificate/authority.pem');
		expect(update_config_value_stub.args[0][2]).to.eql({
			clustering_tls_certificate: 'public/cert.pem',
			clustering_tls_privateKey: 'private/cert.pem',
			clustering_tls_certificateAuthority: 'howdy/im/a/ca.pem',
			tls_certificate: 'public/cert.pem',
			tls_privateKey: 'hi/im/a/private_key.pem',
			tls_certificateAuthority: 'certificate/authority.pem',
		});

		delete process.env['CLUSTERING_TLS_CERTIFICATEAUTHORITY'];
		const command = process.argv.indexOf('--TLS_PRIVATEKEY');
		const value = process.argv.indexOf('hi/im/a/private_key.pem');
		if (command > -1) process.argv.splice(command, 1);
		if (value > -1) process.argv.splice(value, 1);
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
});
