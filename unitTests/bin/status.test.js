'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const fs = require('fs-extra');
const env_mgr = require('#src/utility/environment/environmentManager');
const sys_info = require('#src/utility/environment/systemInformation');
const hdb_terms = require('#src/utility/hdbTerms');
const installation = require('#src/utility/installation');
const status = require('#src/bin/status').default;

describe('Test status module', () => {
	const sandbox = sinon.createSandbox();
	let console_log_stub;
	let get_hdb_process_info_stub;

	const NOW = 1_700_000_000_000;
	const UPTIME_MS = 97_702_000; // 1d 3h 8m 22s

	// `proc.started` is a local-wall-clock string ("YYYY-MM-DD HH:MM:SS") that status parses with
	// Date.parse (local time). Build it from local components of NOW - UPTIME_MS so the round-trip is
	// exact regardless of the machine's timezone.
	const pad = (n) => String(n).padStart(2, '0');
	const started_date = new Date(NOW - UPTIME_MS);
	const STARTED_STR =
		`${started_date.getFullYear()}-${pad(started_date.getMonth() + 1)}-${pad(started_date.getDate())} ` +
		`${pad(started_date.getHours())}:${pad(started_date.getMinutes())}:${pad(started_date.getSeconds())}`;

	const fake_hdb_process_info = {
		core: [{ pid: 62076, started: STARTED_STR }, { pid: 55297 }],
	};

	before(() => {
		console_log_stub = sandbox.stub(console, 'log');
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.ROOTPATH, 'unit-test');
		sandbox.stub(fs, 'readFile').resolves('62076');
		sandbox.stub(Date, 'now').returns(NOW);
		get_hdb_process_info_stub = sandbox.stub(sys_info, 'getHDBProcessInfo').resolves(fake_hdb_process_info);
		sandbox.stub(installation, 'isHdbInstalled').returns(true);
	});

	after(() => {
		sandbox.restore();
	});

	afterEach(() => {
		sandbox.resetHistory();
		get_hdb_process_info_stub.resolves(fake_hdb_process_info);
	});

	it('Test status is returned as expected', async () => {
		const process_exit_stub = sandbox.stub(process, 'exit');
		await status();
		process_exit_stub.restore();
		expect(console_log_stub.args[0][0]).to.eql('harperdb:\n  status: running\n  pid: 62076\n  uptime: 1d 3h 8m 22s\n');
	});

	it('Test status omits uptime when process start time is unparseable but still reports running + pid', async () => {
		const process_exit_stub = sandbox.stub(process, 'exit');
		get_hdb_process_info_stub.resolves({ core: [{ pid: 62076, started: 'not-a-date' }] });

		await status();
		process_exit_stub.restore();
		expect(console_log_stub.args[0][0]).to.eql('harperdb:\n  status: running\n  pid: 62076\n');
	});

	it('Test status when nothing is running', async () => {
		const process_exit_stub = sandbox.stub(process, 'exit');
		get_hdb_process_info_stub.resolves({ core: [] });

		await status();
		process_exit_stub.restore();
		expect(console_log_stub.args[0][0]).to.eql('harperdb:\n  status: stopped\n');
	});
});
