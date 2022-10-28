'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const rewire = require('rewire');
const version = rewire('../../bin/version');

describe('Test version module', () => {
	const sandbox = sinon.createSandbox();

	after(() => {
		sandbox.restore();
	});

	it('Test correct node version is returned', () => {
		const result = version.nodeVersion();
		const package_json = require('../../package.json');
		expect(result).to.equal(package_json.engines['preferred-node']);
	});

	it('Test undefined returned if no json data', () => {
		const json_rw = version.__set__('jsonData', undefined);
		const result = version.nodeVersion();
		expect(result).to.be.undefined;
		json_rw();
	});
});
