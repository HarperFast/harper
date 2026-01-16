'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const rewire = require('rewire');
const fs = require('fs-extra');
const env_mgr = require('#js/utility/environment/environmentManager');
const sys_info = require('#js/utility/environment/systemInformation');
const hdb_terms = require('#src/utility/hdbTerms');
const installation = require('#src/utility/installation');
const status = rewire('#js/bin/status');

describe('Test status module', () => {
	const sandbox = sinon.createSandbox();
	let console_log_stub;
	let read_file_stub;
	let get_hdb_process_info_stub;

	const fake_hdb_process_info = {
		core: [
			{
				pid: 62076,
			},
			{
				pid: 55297,
			},
		],
	};

	before(() => {
		console_log_stub = sandbox.stub(console, 'log');
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.ROOTPATH, 'unit-test');
		read_file_stub = sandbox.stub(fs, 'readFile').resolves('62076');
		get_hdb_process_info_stub = sandbox.stub(sys_info, 'getHDBProcessInfo').resolves(fake_hdb_process_info);
		sandbox.stub(installation, 'isHdbInstalled').returns(true);
	});

	after(() => {
		sandbox.restore();
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	it('Test status is returned as expected', async () => {
		const process_exit_stub = sandbox.stub(process, 'exit');
		await status();
		process_exit_stub.restore();
		expect(console_log_stub.args[0][0]).to.eql('harperdb:\n  status: running\n  pid: 62076\n');
	});

	it('Test status when nothing is running', async () => {
		const process_exit_stub = sandbox.stub(process, 'exit');
		get_hdb_process_info_stub.resolves({ core: [] });

		await status();
		process_exit_stub.restore();
		expect(console_log_stub.args[0][0]).to.eql(
			'harperdb:\n  status: stopped\n'
		);
	});
});
