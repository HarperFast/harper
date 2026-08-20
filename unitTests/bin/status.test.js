'use strict';

const assert = require('assert');
const sinon = require('sinon');
const fs = require('fs-extra');
const env_mgr = require('#src/utility/environment/environmentManager');
const sys_info = require('#src/utility/environment/systemInformation');
const hdb_terms = require('#src/utility/hdbTerms');
const installation = require('#src/utility/installation');
const status_module = require('#src/bin/status');
const status = status_module.default;
const { processUptimeMs } = status_module;

describe('processUptimeMs', () => {
	it('derives uptime in ms between two epoch timestamps', () => {
		assert.strictEqual(processUptimeMs(1_000_000, 1_000_000 + 97_702_000), 97_702_000);
	});

	it('rounds to the nearest ms', () => {
		assert.strictEqual(processUptimeMs(0, 1500.6), 1501);
	});

	it('clamps a future start time to 0', () => {
		assert.strictEqual(processUptimeMs(5000, 0), 0);
	});
});

describe('Test status module', () => {
	const sandbox = sinon.createSandbox();
	const STARTED_MS = 1_700_000_000_000; // pid-file mtime (epoch ms)
	let console_log_stub;
	let get_hdb_process_info_stub;
	let fs_stat_stub;

	const fake_hdb_process_info = {
		core: [{ pid: 62076 }, { pid: 55297 }],
	};

	before(() => {
		console_log_stub = sandbox.stub(console, 'log');
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.ROOTPATH, 'unit-test');
		sandbox.stub(fs, 'readFile').resolves('62076');
		fs_stat_stub = sandbox.stub(fs, 'stat').resolves({ mtimeMs: STARTED_MS });
		get_hdb_process_info_stub = sandbox.stub(sys_info, 'getHDBProcessInfo').resolves(fake_hdb_process_info);
		sandbox.stub(installation, 'isHdbInstalled').returns(true);
	});

	after(() => {
		sandbox.restore();
	});

	afterEach(() => {
		sandbox.resetHistory();
		get_hdb_process_info_stub.resolves(fake_hdb_process_info);
		fs_stat_stub.resolves({ mtimeMs: STARTED_MS });
	});

	it('reports running, pid, and a formatted uptime', async () => {
		await status();
		const output = console_log_stub.args[0][0];
		assert.match(output, /status: running/);
		assert.match(output, /pid: 62076/);
		// Uptime is present and non-empty; the exact derivation is covered by the processUptimeMs tests.
		assert.match(output, /uptime: \S/);
	});

	it('omits uptime when the pid file cannot be stat-ed but still reports running + pid', async () => {
		fs_stat_stub.rejects(new Error('stat failed'));

		await status();
		assert.strictEqual(console_log_stub.args[0][0], 'harperdb:\n  status: running\n  pid: 62076\n');
	});

	it('reports stopped when nothing is running', async () => {
		get_hdb_process_info_stub.resolves({ core: [] });

		await status();
		assert.strictEqual(console_log_stub.args[0][0], 'harperdb:\n  status: stopped\n');
	});
});
