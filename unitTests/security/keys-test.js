'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const fs = require('fs-extra');
const env_mgr = require('../../utility/environment/environmentManager');
const test_utils = require('../test_utils');
const generate_keys = require('../../security/keys');

describe('Test keys module', () => {
	const sandbox = sinon.createSandbox();
	let write_file_stub;
	let console_error_stub;

	beforeEach(() => {
		sandbox.stub(env_mgr, 'getHdbBasePath').returns('keys_test');
		console_error_stub = sandbox.stub(console, 'error');
		write_file_stub = sandbox.stub(fs, 'writeFile');
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('Test generateKeys calls write file with correct params', async () => {
		await generate_keys();
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
		await test_utils.assertErrorAsync(generate_keys, [], err);
		expect(console_error_stub.args[0][0]).to.equal(
			'There was a problem creating the certificate file.  Please check the install log for details.'
		);
	});

	it('Test creating private key file error', async () => {
		const err = new Error('Error writing private key');
		write_file_stub.onCall(1).throws(err);
		await test_utils.assertErrorAsync(generate_keys, [], err);
		expect(console_error_stub.args[0][0]).to.equal(
			'There was a problem creating the private key file.  Please check the install log for details.'
		);
	});

	it('Test creating cert auth file error', async () => {
		const err = new Error('Error writing cert auth');
		write_file_stub.onCall(2).throws(err);
		await test_utils.assertErrorAsync(generate_keys, [], err);
		expect(console_error_stub.args[0][0]).to.equal(
			'There was a problem creating the certificate authority file.  Please check the install log for details.'
		);
	});
});
