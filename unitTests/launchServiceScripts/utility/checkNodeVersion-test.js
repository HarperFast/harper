'use strict';

const rewire = require('rewire');
const check_node = rewire('../../../launchServiceScripts/utility/checkNodeVersion');

const sinon = require('sinon');
const chai = require('chai');
const pjson = require('../../../package.json');
const { expect } = chai;

describe('test checkNodeVersion', () => {
	it('test node versions match', () => {
		let rw_json = check_node.__set__('jsonData', { engines: { node: process.versions.node } });
		let result = check_node();
		expect(result).to.eq(undefined);

		rw_json();
	});

	it('test node version is not in range', () => {
		let node_version_rw = check_node.__set__('INSTALLED_NODE_VERSION', '13.2.3');
		let result = check_node();

		expect(result).to.eql({
			error:
				'This version of HarperDB supports Node.js versions: >=14.0.0, the currently installed Node.js version is: 13.2.3. Please install a version of Node.js that is withing the defined range.',
		});
		node_version_rw();
	});

	it('test node version is in range, not preferred version', () => {
		let node_version_rw = check_node.__set__('INSTALLED_NODE_VERSION', '23.6.0');
		let result = check_node();

		expect(result).to.eql({
			warn: `This version of HarperDB is tested against Node.js version ${pjson.engines['preferred-node']}, the currently installed Node.js` +
				' version is: 23.6.0. Some issues may occur with untested versions of Node.js.',
		});
		node_version_rw();
	});
});
