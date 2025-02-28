'use strict';
/**
 * Test the registrationHandler module.
 */

const assert = require('assert');
const rewire = require('rewire');
const fs = require('fs-extra');
const sinon = require('sinon');
const test_utils = require('../../test_utils');
test_utils.preTestPrep();
const reg = rewire('../../../utility/registration/registrationHandler');
const hdb_license = require('../../../utility/registration/hdb_license');
const { packageJson } = require('../../../utility/packageUtils');
const log = require('../../../utility/logging/harper_logger');

const parse_orig = reg.__get__('parseLicense');

const VALIDATE_SUCCESS = {
	valid_date: true,
	valid_license: true,
	valid_machine: true,
};

describe(`Test setLicense`, function () {
	let write_stub = undefined;
	let validate_stub = undefined;
	let sandbox = null;
	let err = undefined;
	let setLicense = reg.__get__('setLicense');

	beforeEach(() => {
		sandbox = sinon.createSandbox();
	});
	afterEach(() => {
		sandbox.restore();
		reg.__set__('parseLicense', parse_orig);
	});

	after(() => {
		sandbox.restore();
	});

	it('Nominal, set license key stub write file', async function () {
		write_stub = sandbox.stub(fs, 'writeFile').resolves('');
		validate_stub = sandbox.stub().resolves(VALIDATE_SUCCESS);
		reg.__set__('parseLicense', validate_stub);
		let result = undefined;
		try {
			result = await setLicense({
				key: 'e35130571358cd0c79090a782ab44618mofi25nutnRafDD78a36126f0cb549d8fb72e880ef2459d',
				company: 'harperdb.io',
			});
		} catch (e) {
			err = e;
		}
		assert.equal(err, undefined, `expected no exceptions ${err}`);
		assert.equal(result, 'Wrote license key file.  Registration successful.', 'expected success message');
	});
	it('Set license key, invalid license', async function () {
		write_stub = sandbox.stub(fs, 'writeFile').throws(new Error('BAD WRITE'));
		let copy = test_utils.deepClone(VALIDATE_SUCCESS);
		copy.valid_license = false;
		validate_stub = sandbox.stub(hdb_license, 'validateLicense').resolves(copy);
		let result = undefined;
		try {
			result = await setLicense({ key: 'blahblah', company: 'harperdb.io' });
		} catch (e) {
			err = e;
		}
		assert.notEqual(err, undefined, 'expected exception');
		assert.equal(
			err.message.indexOf('There was an error parsing the license key.') > -1,
			true,
			'expected error message'
		);
	});
	it('Set license key invalid json message', async function () {
		write_stub = sandbox.stub(fs, 'writeFile').throws(new Error('BAD WRITE'));
		let result = undefined;
		try {
			result = await setLicense(null);
		} catch (e) {
			err = e;
		}
		assert.notEqual(err, undefined, 'expected exceptions');
		assert.equal(err.message, 'Invalid key or company specified for license file.', 'expected error message');
	});
	it('Set license key invalid key in json message', async function () {
		write_stub = sandbox.stub(fs, 'writeFile').throws(new Error('BAD WRITE'));
		let result = undefined;
		try {
			result = await setLicense({ key: null, company: 'harperdb.io' });
		} catch (e) {
			err = e;
		}
		assert.notEqual(err, undefined, 'expected exceptions');
		assert.equal(err.message, 'Invalid key or company specified for license file.', 'expected error message');
	});
});

describe(`Test getFingerprint`, function () {
	let generate_stub = undefined;
	let sandbox = null;
	let err = undefined;
	let getFingerprint = reg.__get__('getFingerprint');

	beforeEach(() => {
		sandbox = sinon.createSandbox();
	});
	afterEach(() => {
		sandbox.restore();
	});

	after(() => {
		sandbox.restore();
	});

	it('Nominal, set license key stub write file', async function () {
		generate_stub = sandbox.stub(hdb_license, 'generateFingerPrint').resolves('blahhash');
		let result = undefined;
		try {
			result = await getFingerprint();
		} catch (e) {
			err = e;
		}
		assert.equal(err, undefined, 'expected no exceptions');
		assert.equal(result, 'blahhash', 'expected success message');
	});
	it('Set license key stub write file, write throws exception', async function () {
		generate_stub = sandbox
			.stub(hdb_license, 'generateFingerPrint')
			.throws(new Error('There was an error generating the fingerprint'));
		let result = undefined;
		try {
			result = await getFingerprint();
		} catch (e) {
			err = e;
		}
		assert.equal(err.message, 'Error generating fingerprint.', 'expected error message');
	});
});

describe(`Test getRegistrationInfo`, function () {
	let getLicense_stub;
	let version_stub;
	let log_spy;
	let test_license = {
		enterprise: true,
		storage_type: 'lmdb',
		exp_date: '2021-06-10',
		api_call: 1000,
		ram_allocation: 12345,
	};
	let test_api_calls = 55;
	let test_version = '2.0.000';
	let err_msg = 'Error message';
	let sandbox;
	let err;

	beforeEach(() => {
		sandbox = sinon.createSandbox();
		getLicense_stub = sandbox.stub(hdb_license, 'getLicense').resolves(test_license);
		version_stub = sandbox.stub(packageJson, 'version').get(() => test_version);
		log_spy = sandbox.spy(log, 'error');
	});
	afterEach(() => {
		sandbox.restore();
		err = undefined;
	});

	it('Should return correct license and api info', async function () {
		let result;
		try {
			result = await reg.getRegistrationInfo();
		} catch (e) {
			err = e;
		}

		assert.equal(result.registered, test_license.enterprise, 'Expected value to be true');
		assert.equal(result.version, test_version, `Expected value to be ${test_version}`);
		assert.equal(
			result.license_expiration_date,
			test_license.exp_date,
			`Expected value to be ${test_license.exp_date}`
		);
		//assert.equal(result.daily_api_calls_current, test_api_calls, `Expected value to be ${test_api_calls}`);
		//assert.equal(result.daily_api_calls_limit, test_license.api_call, `Expected value to be ${test_license.api_call}`);
		assert.equal(
			result.ram_allocation,
			test_license.ram_allocation,
			`Expected value to be ${test_license.ram_allocation}`
		);
	});

	it('Should return null for expiration date if not registered', async function () {
		const test_default_license = Object.assign(test_license, { enterprise: false });
		getLicense_stub.resolves(test_default_license);
		let result;
		try {
			result = await reg.getRegistrationInfo();
		} catch (e) {
			err = e;
		}

		assert.equal(
			result.registered,
			test_default_license.enterprise,
			`Expected value to be ${test_default_license.enterprise}`
		);
		assert.equal(result.license_expiration_date, null, `Expected value to be null`);
	});

	it('Should throw an error is a license is not found', async function () {
		getLicense_stub.resolves(null);
		let result;
		try {
			await reg.getRegistrationInfo();
		} catch (e) {
			err = e;
		}

		assert.equal(err.message, 'There were no licenses found.', 'expected error message');
	});

	it('Should throw and log an error if getLicense throws an error', async function () {
		getLicense_stub.throws(new Error(err_msg));
		let result;
		try {
			await reg.getRegistrationInfo();
		} catch (e) {
			err = e;
		}

		assert.equal(err.message, err_msg, 'expected error message');
		assert.equal(log_spy.calledOnce, true, 'expected error to be logged');
	});
});
