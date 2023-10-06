'use strict';

const rewire = require('rewire');
const check_node = rewire('../../../launchServiceScripts/utility/checkNodeVersion');

const sinon = require('sinon');
const chai = require('chai');
const pjson = require('../../../package.json');
const { expect } = chai;

describe('test checkNodeVersion', () => {
	it('test node versions match', () => {
		let rw_json = check_node.__set__('jsonData', { engines: { 'minimum-node': process.versions.node } });
		let result = check_node();
		expect(result).to.eq(undefined);

		rw_json();
	});

	it('test node version is not in range', () => {
		let node_version_rw = check_node.__set__('INSTALLED_NODE_VERSION', '13.2.3');
		let result = check_node();

		expect(result).to.eql({
			error:
				'The minimum version of Node.js HarperDB supports is: 16.0.0, the currently installed Node.js version is: 13.2.3. Please install a version of Node.js that is withing the defined range.',
		});
		node_version_rw();
	});
});
