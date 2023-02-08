'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const fs = require('fs-extra');
const env_mgr = require('../../utility/environment/environmentManager');
const test_utils = require('../test_utils');
const keys = require('../../security/keys');
const config_utils = require('../../config/configUtils');

describe('Test keys module', () => {
	const sandbox = sinon.createSandbox();
	let write_file_stub;
	let console_error_stub;
	let update_config_value_stub;

	beforeEach(() => {
		sandbox.stub(env_mgr, 'getHdbBasePath').returns('keys_test');
		console_error_stub = sandbox.stub(console, 'error');
		write_file_stub = sandbox.stub(fs, 'writeFile');
		update_config_value_stub = sandbox.stub(config_utils, 'updateConfigValue');
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('Test generateKeys calls write file with correct params', async () => {
		await keys.generateKeys();
		expect(write_file_stub.getCall(0).args[0]).to.include('certificate.pem');
		expect(write_file_stub.getCall(0).args[1]).to.include('BEGIN CERTIFICATE');
		expect(write_file_stub.getCall(1).args[0]).to.include('privateKey.pem');
		expect(write_file_stub.getCall(1).args[1]).to.include('BEGIN RSA PRIVATE KEY');
		expect(write_file_stub.getCall(2).args[0]).to.include('ca.pem');
		expect(write_file_stub.getCall(2).args[1]).to.include('BEGIN CERTIFICATE');
	});

	it('Test creating cert file error', async () => {
		const err = new Error('Error writing cert file');
		write_file_stub.throws(err);
		await test_utils.assertErrorAsync(keys.generateKeys, [], err);
		expect(console_error_stub.args[0][0]).to.equal(
			'There was a problem creating the certificate file.  Please check the install log for details.'
		);
	});

	it('Test creating private key file error', async () => {
		const err = new Error('Error writing private key');
		write_file_stub.onCall(1).throws(err);
		await test_utils.assertErrorAsync(keys.generateKeys, [], err);
		expect(console_error_stub.args[0][0]).to.equal(
			'There was a problem creating the private key file.  Please check the install log for details.'
		);
	});

	it('Test creating cert auth file error', async () => {
		const err = new Error('Error writing cert auth');
		write_file_stub.onCall(2).throws(err);
		await test_utils.assertErrorAsync(keys.generateKeys, [], err);
		expect(console_error_stub.args[0][0]).to.equal(
			'There was a problem creating the certificate authority file.  Please check the install log for details.'
		);
	});

	it('Test updateConfigCert builds new cert config correctly', () => {
		process.env['CLUSTERING_TLS_CERTIFICATEAUTHORITY'] = 'howdy/im/a/ca.pem';
		process.argv.push('--CUSTOMFUNCTIONS_TLS_PRIVATEKEY', 'hi/im/a/private_key.pem');
		keys.updateConfigCert('public/cert.pem', 'private/cert.pem', 'certificate/authority.pem');
		expect(update_config_value_stub.args[0][2]).to.eql({
			clustering_tls_certificate: 'public/cert.pem',
			clustering_tls_privateKey: 'private/cert.pem',
			clustering_tls_certificateAuthority: 'howdy/im/a/ca.pem',
			customFunctions_tls_certificate: 'public/cert.pem',
			customFunctions_tls_privateKey: 'hi/im/a/private_key.pem',
			customFunctions_tls_certificateAuthority: 'certificate/authority.pem',
			operationsApi_tls_certificate: 'public/cert.pem',
			operationsApi_tls_privateKey: 'private/cert.pem',
			operationsApi_tls_certificateAuthority: 'certificate/authority.pem',
		});
	});
});
