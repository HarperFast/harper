'use strict';

const assert = require('node:assert');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { runBackupCommand } = require('#src/bin/backup');
const cliOperationsModule = require('#src/bin/cliOperations');
const commonUtilsModule = require('#src/utility/common_utils');
const cliCredentialsModule = require('#src/bin/cliCredentials');
const processMgmtModule = require('#src/utility/processManagement/processManagement');
const rocksdbBackupModule = require('#src/dataLayer/rocksdbBackup');
const configUtilsModule = require('#src/config/configUtils');

describe('backup.ts get_backup download (atomic write)', () => {
	let tmpDir;
	let originalArgv;
	let originalResolveRequestOptions;
	let originalHttpRequest;
	let originalConsoleLog;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-test-backup-'));
		originalArgv = process.argv;
		originalResolveRequestOptions = cliOperationsModule.resolveRequestOptions;
		originalHttpRequest = commonUtilsModule.httpRequest;
		originalConsoleLog = console.log;
		console.log = () => {};

		cliOperationsModule.resolveRequestOptions = async () => ({ options: {} });
	});

	afterEach(() => {
		process.argv = originalArgv;
		cliOperationsModule.resolveRequestOptions = originalResolveRequestOptions;
		commonUtilsModule.httpRequest = originalHttpRequest;
		console.log = originalConsoleLog;
		fs.removeSync(tmpDir);
	});

	// A fake server response: a Readable body plus the statusCode/headers httpRequest normally attaches.
	function fakeResponse(streamBody) {
		const response = streamBody;
		response.statusCode = 200;
		response.headers = { 'content-disposition': 'attachment; filename="data.tar.gz"' };
		return response;
	}

	function partFiles() {
		return fs.readdirSync(tmpDir).filter((name) => name.endsWith('.part'));
	}

	it('writes the full response body to outputPath and leaves no .part temp file behind', async () => {
		const outputPath = path.join(tmpDir, 'my.tar.gz');
		process.argv = ['node', 'harper', 'get_backup', `out=${outputPath}`];

		commonUtilsModule.httpRequest = async () =>
			fakeResponse(Readable.from([Buffer.from('chunk-1-'), Buffer.from('chunk-2')]));

		await runBackupCommand('get_backup');

		assert.strictEqual(fs.readFileSync(outputPath, 'utf8'), 'chunk-1-chunk-2');
		assert.deepStrictEqual(partFiles(), []);
	});

	it('on a mid-stream failure, leaves no file at outputPath and removes the .part temp file', async () => {
		const outputPath = path.join(tmpDir, 'my.tar.gz');
		process.argv = ['node', 'harper', 'get_backup', `out=${outputPath}`];

		commonUtilsModule.httpRequest = async () =>
			fakeResponse(
				new Readable({
					read() {
						this.push(Buffer.from('partial-data'));
						this.destroy(new Error('simulated network failure'));
					},
				})
			);

		await assert.rejects(() => runBackupCommand('get_backup'), /simulated network failure/);

		assert.strictEqual(fs.existsSync(outputPath), false);
		assert.deepStrictEqual(partFiles(), []);
	});

	it('on a failure when a good backup already exists at outputPath, leaves the existing file untouched', async () => {
		const outputPath = path.join(tmpDir, 'my.tar.gz');
		const existingContent = 'previously-good-backup-contents';
		fs.writeFileSync(outputPath, existingContent);
		process.argv = ['node', 'harper', 'get_backup', `out=${outputPath}`];

		commonUtilsModule.httpRequest = async () =>
			fakeResponse(
				new Readable({
					read() {
						this.push(Buffer.from('partial-data'));
						this.destroy(new Error('simulated network failure'));
					},
				})
			);

		await assert.rejects(() => runBackupCommand('get_backup'), /simulated network failure/);

		assert.strictEqual(fs.readFileSync(outputPath, 'utf8'), existingContent);
		assert.deepStrictEqual(partFiles(), []);
	});
});

describe('backup.ts offline routing (useOperationApi)', () => {
	let saved;

	beforeEach(() => {
		saved = {
			argv: process.argv,
			loadCredentials: cliCredentialsModule.loadCredentials,
			getHdbPid: processMgmtModule.getHdbPid,
			listBackupsOffline: rocksdbBackupModule.listBackupsOffline,
			cliOperations: cliOperationsModule.cliOperations,
			initConfig: configUtilsModule.initConfig,
			log: console.log,
			envHarper: process.env.HARPER_CLI_TARGET,
			envCli: process.env.CLI_TARGET,
		};
		console.log = () => {};
		configUtilsModule.initConfig = () => {};
		delete process.env.HARPER_CLI_TARGET;
		delete process.env.CLI_TARGET;
		process.argv = ['node', 'harper', 'list_backups'];
	});

	afterEach(() => {
		process.argv = saved.argv;
		cliCredentialsModule.loadCredentials = saved.loadCredentials;
		processMgmtModule.getHdbPid = saved.getHdbPid;
		rocksdbBackupModule.listBackupsOffline = saved.listBackupsOffline;
		cliOperationsModule.cliOperations = saved.cliOperations;
		configUtilsModule.initConfig = saved.initConfig;
		console.log = saved.log;
		if (saved.envHarper === undefined) delete process.env.HARPER_CLI_TARGET;
		else process.env.HARPER_CLI_TARGET = saved.envHarper;
		if (saved.envCli === undefined) delete process.env.CLI_TARGET;
		else process.env.CLI_TARGET = saved.envCli;
	});

	function trackRouting() {
		const calls = { offline: false, api: false };
		rocksdbBackupModule.listBackupsOffline = async () => {
			calls.offline = true;
			return [];
		};
		cliOperationsModule.cliOperations = async () => {
			calls.api = true;
		};
		return calls;
	}

	it('uses the offline file path when a saved last_target is local and the server is stopped', async () => {
		cliCredentialsModule.loadCredentials = () => ({ last_target: 'http://localhost:9925/' });
		processMgmtModule.getHdbPid = () => null; // stopped
		const calls = trackRouting();
		await runBackupCommand('list_backups');
		assert.ok(calls.offline, 'a local last_target with the server stopped must use the offline path');
		assert.ok(!calls.api, 'must not forward to the API');
	});

	it('still forwards to the API for a remote last_target even when the local server is stopped', async () => {
		cliCredentialsModule.loadCredentials = () => ({ last_target: 'https://remote.example.com:9925/' });
		processMgmtModule.getHdbPid = () => null;
		const calls = trackRouting();
		await runBackupCommand('list_backups');
		assert.ok(calls.api, 'a remote last_target must forward to the API');
		assert.ok(!calls.offline);
	});

	it('uses the API path for a local last_target when the local server IS running', async () => {
		cliCredentialsModule.loadCredentials = () => ({ last_target: 'http://127.0.0.1:9925/' });
		processMgmtModule.getHdbPid = () => 12345; // running
		const calls = trackRouting();
		await runBackupCommand('list_backups');
		assert.ok(calls.api, 'a running local server should be reached via the API');
		assert.ok(!calls.offline);
	});
});
