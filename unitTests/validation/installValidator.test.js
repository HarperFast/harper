'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const fs = require('fs-extra');
const installValidator = require('#src/validation/installValidator').default;

describe('Test installValidator module', () => {
	const sandbox = sinon.createSandbox();

	before(() => {
		sandbox.stub(fs, 'existsSync').returns(true);
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
		expect(result.message).to.equal("'i/am/root' is already in use. Please enter a different path.");
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
		expect(result.message).to.equal("'i/am/root' is already in use. Please enter a different path.");
	});
});
