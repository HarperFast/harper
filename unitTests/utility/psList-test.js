'use strict';
const chai = require('chai');
const rewire = require('rewire');

let find_ps = rewire('../../utility/psList');
const { expect } = chai;

describe('Test ps_list', () => {
	if (process.platform === 'win32')
		// ps is a linux command; there are alternate ways to do this on Windows, but would need to implement
		// something specifically for Windows
		return;
	let execFunc = async () => {
		return { stdout: 'PID COMM\n 280 /harperdb/server/operationsServer.js\n' };
	};

	afterEach(() => {
		find_ps = rewire('../../utility/psList');
	});

	it('should return an array of objects', async () => {
		let result = await find_ps.findPs('');
		expect(result).to.be.a('array');
		expect(result[0]).to.be.a('object');
		expect(result[0]).to.have.property('pid');
		expect(result[0]).to.have.property('name');
		expect(result[0]).to.have.property('cmd');
		expect(result[0]).to.have.property('ppid');
		expect(result[0]).to.have.property('uid');
		expect(result[0]).to.have.property('cpu');
		expect(result[0]).to.have.property('memory');
	});

	it('should return hdbServer process', async () => {
		find_ps.__set__('execFile', execFunc);
		let result = await find_ps.findPs('');
		expect(result).to.be.a('array');
		expect(result[0]).to.be.a('object');
		expect(result[0]).to.have.property('pid');
		expect(result[0]).to.have.property('name');
		expect(result[0]).to.have.property('cmd');
		expect(result[0]).to.have.property('pid').equal(280);
		expect(result[0]).to.have.property('pid').not.equal(28);
		expect(result[0]).to.have.property('name').equal('operationsServer.js');
		expect(result[0]).to.have.property('cmd').equal('/harperdb/server/operationsServer.js');
	});
});
