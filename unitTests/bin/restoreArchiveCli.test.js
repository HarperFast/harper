'use strict';

const assert = require('node:assert');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { saveCredentials } = require('#js/bin/cliCredentials');
const cliOperationsModule = require('#src/bin/cliOperations');
const cliOperationsJs = require('#js/bin/cliOperations');
const { Readable } = require('node:stream');
const { runBackupCommand } = require('#src/bin/backup');
const commonUtilsModule = require('#src/utility/common_utils');
const tokenAuthModule = require('#src/security/tokenAuthentication');

class ProcessExitSignal extends Error {
	constructor(code) {
		super(`process.exit(${code})`);
		this.code = code;
	}
}

describe('restore_backup file= from the CLI', () => {
	const testDir = path.join(os.tmpdir(), `harper-test-restore-archive-cli-${process.pid}`);
	const target = 'https://example.com:9925/';
	const archive = path.join(testDir, 'orders.tar.gz');
	const archiveBytes = Buffer.from('not really gzip, the server is mocked'.repeat(100));
	let saved;
	let errorLines;

	before(() => {
		saved = {
			home: process.env.HOME,
			httpRequest: commonUtilsModule.httpRequest,
			isJWTExpired: tokenAuthModule.isJWTExpired,
		};
		process.env.HOME = testDir;
		fs.ensureDirSync(testDir);
		fs.writeFileSync(archive, archiveBytes);
	});

	after(() => {
		if (saved) {
			process.env.HOME = saved.home;
			commonUtilsModule.httpRequest = saved.httpRequest;
			tokenAuthModule.isJWTExpired = saved.isJWTExpired;
		}
		fs.removeSync(testDir);
	});

	beforeEach(() => {
		saved.exit = process.exit;
		saved.consoleError = console.error;
		saved.argv = process.argv;
		errorLines = [];
		process.exit = (code) => {
			throw new ProcessExitSignal(code);
		};
		console.error = (...args) => errorLines.push(args.join(' '));
		saveCredentials(target, { operation_token: 'valid-token', refresh_token: 'refresh-token' });
		tokenAuthModule.isJWTExpired = () => false;
	});

	afterEach(() => {
		if (!saved) return;
		process.exit = saved.exit;
		console.error = saved.consoleError;
		process.argv = saved.argv;
		process.env.HOME = testDir;
	});

	it('uploads only to a server that advertises archive restore, whatever its version', () => {
		const { advertisesArchiveRestore } = cliOperationsModule;
		const { getRegistrationInfo } = require('#src/resources/registrationDeprecated');
		assert.strictEqual(advertisesArchiveRestore(getRegistrationInfo()), true, 'this build advertises it');
		assert.strictEqual(advertisesArchiveRestore({ version: '9.0.0', capabilities: ['restore_backup_archive'] }), true);
		// a server built from the same version number before the capability existed restores its latest backup
		for (const info of [
			{ version: getRegistrationInfo().version, deprecated: true },
			{ version: '9.0.0', capabilities: [] },
			{ version: '9.0.0', capabilities: 'restore_backup_archive' },
			{ version: '9.0.0', capabilities: { restore_backup_archive: true } },
			null,
			undefined,
			'restore_backup_archive',
		])
			assert.strictEqual(advertisesArchiveRestore(info), false, JSON.stringify(info));
	});

	it('never sends the restore to a server that would ignore the archive and restore its latest backup', async () => {
		const calls = [];
		commonUtilsModule.httpRequest = async (options, body) => {
			calls.push(body);
			return { statusCode: 200, body: JSON.stringify({ version: '5.4.0', deprecated: true }) };
		};
		await assert.rejects(
			cliOperationsModule.cliOperations(
				{ operation: 'restore_backup', database: 'orders', file: archive, target: 'example.com' },
				true
			),
			ProcessExitSignal
		);
		assert.deepStrictEqual(
			calls.map((body) => body.operation),
			['registration_info']
		);
		assert.match(errorLines.join('\n'), /would restore its latest managed backup instead/);
	});

	it('refuses when the probe itself fails', async () => {
		const calls = [];
		commonUtilsModule.httpRequest = async (options, body) => {
			calls.push(body.operation);
			if (body.operation === 'registration_info')
				throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
			return { statusCode: 200, body: '{}' };
		};
		await assert.rejects(
			cliOperationsModule.cliOperations(
				{ operation: 'restore_backup', database: 'orders', file: archive, target: 'example.com' },
				true
			),
			ProcessExitSignal
		);
		assert.deepStrictEqual(calls, ['registration_info']);
		assert.doesNotMatch(errorLines.join('\n'), /Upgrade it/, 'a connection failure is not reported as an old server');
		assert.match(errorLines.join('\n'), /socket hang up/);
	});

	it('reports a probe the server refused as that refusal, not as an old server', async () => {
		for (const [statusCode, hint] of [
			[401, /credentials/],
			[403, /allowed registration_info/],
		]) {
			errorLines = [];
			const calls = [];
			commonUtilsModule.httpRequest = async (options, body) => {
				calls.push(body.operation);
				return { statusCode, body: JSON.stringify({ error: 'not for you' }) };
			};
			await assert.rejects(
				cliOperationsModule.cliOperations(
					{ operation: 'restore_backup', database: 'orders', file: archive, target: 'example.com' },
					true
				),
				ProcessExitSignal
			);
			assert.deepStrictEqual(calls, ['registration_info'], 'nothing is uploaded');
			const printed = errorLines.join('\n');
			assert.match(printed, new RegExp(`status ${statusCode} \\(not for you\\)`));
			assert.match(printed, hint);
			assert.doesNotMatch(printed, /Upgrade it/);
		}
	});

	it('reports an archive that cannot be opened once the upload starts as the archive, with nothing left erroring', async () => {
		const vanishing = path.join(testDir, 'vanishing.tar.gz');
		fs.writeFileSync(vanishing, archiveBytes);
		const escapes = [];
		const onEscape = (error) => escapes.push(error);
		process.on('uncaughtException', onEscape);
		commonUtilsModule.httpRequest = async (options, body) => {
			if (body.operation === 'registration_info') {
				// gone after the CLI sized it, before the body reaches it
				fs.removeSync(vanishing);
				return { statusCode: 200, body: JSON.stringify({ capabilities: ['restore_backup_archive'] }) };
			}
			// let any stream opened ahead of the body report its failure first
			await new Promise((resolve) => setTimeout(resolve, 20));
			for await (const _chunk of body);
			return { statusCode: 200, body: '{}' };
		};
		try {
			await assert.rejects(
				cliOperationsModule.cliOperations(
					{ operation: 'restore_backup', database: 'orders', file: vanishing, target: 'example.com' },
					true
				),
				ProcessExitSignal
			);
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			process.off('uncaughtException', onEscape);
		}
		assert.deepStrictEqual(escapes, []);
		assert.match(errorLines.join('\n'), /Cannot read the archive '.*vanishing\.tar\.gz': ENOENT/);
	});

	it('uploads the file as the last multipart part, with the body length the server sizes it by', async () => {
		const calls = [];
		commonUtilsModule.httpRequest = async (options, body) => {
			if (body.operation === 'registration_info') {
				calls.push({ probe: true });
				return {
					statusCode: 200,
					body: JSON.stringify({ version: '5.4.0', capabilities: ['restore_backup_archive'] }),
				};
			}
			const chunks = [];
			for await (const chunk of body) chunks.push(chunk);
			calls.push({ options, sent: Buffer.concat(chunks) });
			return { statusCode: 200, body: JSON.stringify({ job_id: 'j', archive_sha256: 'a'.repeat(64) }) };
		};
		const result = await cliOperationsModule.cliOperations(
			{ operation: 'restore_backup', database: 'orders', file: archive, on_restart: true, target: 'example.com' },
			true
		);
		assert.strictEqual(result.job_id, 'j');
		const [probe, upload] = calls;
		assert.ok(probe.probe);
		assert.strictEqual(upload.options.headers['Content-Length'], upload.sent.length);
		assert.match(upload.options.headers['Content-Type'], /^multipart\/form-data; boundary=/);
		const text = upload.sent.toString('latin1');
		assert.match(text, /name="operation"\r\n\r\nrestore_backup\r\n/);
		assert.match(text, /name="on_restart"\r\n\r\ntrue\r\n/);
		assert.doesNotMatch(text, /name="file"/, 'the local path never reaches the server');
		const payloadAt = text.indexOf('name="payload"; filename="orders.tar.gz"');
		assert.ok(payloadAt > text.indexOf('name="on_restart"'), 'the file part comes after every field');
		assert.ok(upload.sent.includes(archiveBytes));
	});

	it('refuses an archive given as a bare word, which the parser would otherwise drop', async () => {
		process.argv = ['node', 'harper', 'restore_backup', 'orders.tar.gz', 'database=orders'];
		await assert.rejects(runBackupCommand('restore_backup'), /pass file=orders.tar.gz/);
	});

	it('refuses a bare word after a flag, which the parser ignores along with the flag', async () => {
		process.argv = ['node', 'harper', 'restore_backup', '--verbose', 'orders.tar.gz', 'database=orders'];
		await assert.rejects(runBackupCommand('restore_backup'), /pass file=orders.tar.gz/);
	});

	it('refuses options offline resume would ignore', async () => {
		const { resolveDatabasePath } = require('#src/resources/databases');
		const { restoreReceiptPath } = require('#src/dataLayer/restoreReceipt');
		const name = `restore_archive_cli_resume_${process.pid}`;
		const databaseDir = resolveDatabasePath(name);
		const receiptPath = restoreReceiptPath(databaseDir);
		fs.ensureDirSync(path.dirname(receiptPath));
		fs.writeFileSync(
			receiptPath,
			JSON.stringify({
				version: 2,
				operation_id: 'op',
				route: 'online',
				state: 'applying',
				database: name,
				database_path: databaseDir,
				source_database: name,
				backup_dir: path.join(testDir, 'backups'),
				source_kind: 'staged_tree',
				staging_dir: path.join(testDir, 'staging'),
				attempts: 1,
				options: {},
			})
		);
		// no saved target, so the CLI finds the local server stopped and restores offline
		process.env.HOME = path.join(testDir, 'no-credentials');
		try {
			for (const [extra, refusal] of [
				['backup_id=1', /omit 'backup_id' and 'on_restart'/],
				['on_restart=true', /omit 'backup_id' and 'on_restart'/],
				['accept_unverified_blobs=true', /takes no 'accept_unverified_blobs'/],
				[`sha256=${'a'.repeat(64)}`, /takes no 'sha256'/],
			]) {
				process.argv = ['node', 'harper', 'restore_backup', `database=${name}`, 'resume=true', extra];
				await assert.rejects(runBackupCommand('restore_backup'), refusal, extra);
			}
		} finally {
			fs.removeSync(receiptPath);
		}
	});

	it('names what works when offline resume finds an archive restore scheduled for startup', async () => {
		const { resolveDatabasePath } = require('#src/resources/databases');
		const { restoreReceiptPath } = require('#src/dataLayer/restoreReceipt');
		const name = `restore_archive_cli_restart_${process.pid}`;
		const databaseDir = resolveDatabasePath(name);
		const receiptPath = restoreReceiptPath(databaseDir);
		fs.ensureDirSync(path.dirname(receiptPath));
		process.env.HOME = path.join(testDir, 'no-credentials');
		try {
			for (const [state, guidance] of [
				['applying', /had begun replacing it; start Harper, which retries it/],
				['pending', /start Harper, or withdraw it with restore_backup cancel=true/],
				[
					'terminal',
					/start Harper and rerun restore_backup resume=true, or withdraw it with restore_backup cancel=true/,
				],
			]) {
				fs.writeFileSync(
					receiptPath,
					JSON.stringify({
						version: 2,
						operation_id: 'op',
						route: 'on_restart',
						state,
						database: name,
						database_path: databaseDir,
						source_database: name,
						backup_dir: path.join(testDir, 'backups'),
						source_kind: 'staged_tree',
						staging_dir: path.join(testDir, 'staging'),
						attempts: 1,
						options: {},
					})
				);
				process.argv = ['node', 'harper', 'restore_backup', `database=${name}`, 'resume=true'];
				await assert.rejects(
					runBackupCommand('restore_backup'),
					(error) =>
						guidance.test(error.message) &&
						!/omitting/.test(error.message) &&
						(state !== 'applying' || !/cancel/.test(error.message)),
					state
				);
			}
		} finally {
			fs.removeSync(receiptPath);
		}
	});

	it('leaves a stray word alone on the other backup commands, where dropping it misreads nothing', async () => {
		const out = path.join(testDir, 'download.tar.gz');
		process.argv = ['node', 'harper', 'get_backup', 'stray', 'database=orders', `out=${out}`];
		const savedResolve = cliOperationsJs.resolveRequestOptions;
		const savedLog = console.log;
		cliOperationsJs.resolveRequestOptions = async () => ({ options: {} });
		console.log = () => {};
		commonUtilsModule.httpRequest = async () =>
			Object.assign(Readable.from([Buffer.from('archive')]), { statusCode: 200, headers: {} });
		try {
			await runBackupCommand('get_backup');
		} finally {
			cliOperationsJs.resolveRequestOptions = savedResolve;
			console.log = savedLog;
		}
		assert.strictEqual(fs.readFileSync(out, 'utf8'), 'archive');
	});
});
