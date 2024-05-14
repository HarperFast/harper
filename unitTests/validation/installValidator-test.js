'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const fs = require('fs-extra');
const installValidator = require('../../validation/installValidator');

describe('Test installValidator module', () => {
	const sandbox = sinon.createSandbox();
	let exists_sync_stub;

	before(() => {
		exists_sync_stub = sandbox.stub(fs, 'existsSync').returns(true);
	});

	after(() => {
		sandbox.restore();
	});

	it('Test validation error returned all values bad', () => {
		const test_params = {
			ROOTPATH: 'i/am/root',
			OPERATIONSAPI_NETWORK_PORT: '1a',
			TC_AGREEMENT: 'no',
			CLUSTERING_NODENAME: 'dev.dog',
			CLUSTERING_ENABLED: 'yes',
		};

		const result = installValidator(test_params);
		expect(result.message).to.equal(
			"'i/am/root' is already in use. Please enter a different path.. 'TC_AGREEMENT' must be one of [yes, YES, Yes]. 'CLUSTERING_NODENAME' invalid, must not contain ., * or >. 'CLUSTERING_ENABLED' must be a boolean"
		);
	});

	it('Test validation error returned some values bad', () => {
		const test_params = {
			ROOTPATH: 'i/am/root',
			OPERATIONSAPI_NETWORK_PORT: 1234,
			TC_AGREEMENT: 'yes',
			CLUSTERING_NODENAME: 'dev.dog',
			CLUSTERING_ENABLED: 1,
		};

		const result = installValidator(test_params);
		expect(result.message).to.equal(
			"'i/am/root' is already in use. Please enter a different path.. 'CLUSTERING_NODENAME' invalid, must not contain ., * or >. 'CLUSTERING_ENABLED' must be a boolean"
		);
	});
});
