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

	// NODE_HOSTNAME is this node's identity, so install rejects a non-bare-host value here rather than
	// letting it fail at first boot (#2218). This runs after installer.ts copies a v5 upgrade's
	// REPLICATION_HOSTNAME into NODE_HOSTNAME, which is how a URL-ish legacy value reaches install.
	it('rejects a NODE_HOSTNAME that is not a bare host', () => {
		for (const [value, reason] of [
			['http://localhost:9926', 'must not include a URL scheme'],
			['localhost:9925', 'must not include a port'],
			['[::1]', 'must be an unbracketed IPv6 literal'],
		]) {
			const result = installValidator({ NODE_HOSTNAME: value });
			expect(result?.message, `expected ${value} to be rejected`).to.include(`'NODE_HOSTNAME' ${reason}`);
		}
	});

	it('accepts a bare-host NODE_HOSTNAME, and leaves an unset one alone', () => {
		for (const value of ['node1.example.com', '::1', '127.0.0.1', null, undefined]) {
			expect(installValidator({ NODE_HOSTNAME: value }), `expected ${value} to be accepted`).to.be.undefined;
		}
	});
});
