'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const hdb_logger = require('../../utility/logging/harper_logger');
const rewire = require('rewire');
const install = rewire('../../bin/install');

describe('Test install module', () => {
	const sandbox = sinon.createSandbox();
	let installer_stub;

	before(() => {
		installer_stub = sandbox.stub();
		install.__set__('installer.install', installer_stub);
	});

	after(() => {
		sandbox.restore();
	});

	it('Test error from installer is handled correctly', async () => {
		const err_msg = 'Something is wrong';
		const console_error_stub = sandbox.stub(console, 'error');
		const hdb_log_error_stub = sandbox.stub(hdb_logger, 'error');
		const process_exit_stub = sandbox.stub(process, 'exit');
		installer_stub.throws(err_msg);
		await install();
		expect(console_error_stub.getCall(0).args[0]).to.equal('There was an error during the install.');
		expect(console_error_stub.getCall(1).args[0].name).to.equal(err_msg);
		expect(hdb_log_error_stub.args[0][0].name).to.equal(err_msg);
		expect(process_exit_stub.called).to.be.true;
		process_exit_stub.restore();
	});
});
