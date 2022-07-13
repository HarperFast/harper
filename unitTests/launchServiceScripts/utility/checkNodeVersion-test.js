'use strict';

const rewire = require('rewire');
const check_node = rewire('../../../launchServiceScripts/utility/checkNodeVersion');

const sinon = require('sinon');
const chai = require('chai');
const { expect } = chai;

describe('test checkNodeVersion', () => {
	it('test node versions match', () => {
		let rw_json = check_node.__set__('jsonData', { engines: { node: process.versions.node } });
		let result = check_node();
		expect(result).to.eq(undefined);

		rw_json();
	});

	it('test node versions do not match', () => {
		let rw_json = check_node.__set__('jsonData', { engines: { node: '3.0.0' } });

		let result = check_node();
		expect(result).to.eql({
			error:
				'This version of HarperDB is designed to run on Node 3.0.0, the currently installed Node.js version is: 16.16.0.  Please change to version of Node.js 3.0.0 to proceed.',
		});

		rw_json();
	});
});
