'use strict';

const assert = require('node:assert');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { runBackupCommand } = require('#src/bin/backup');
const cliOperationsModule = require('#src/bin/cliOperations');
const commonUtilsModule = require('#src/utility/common_utils');

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
