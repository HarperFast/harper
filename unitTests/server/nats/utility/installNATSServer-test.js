'use strict';

const rewire = require('rewire');
const installer = rewire('../../../../server/nats/utility/installNATSServer');
const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const chalk = require('chalk');
const test_utils = require('../../../test_utils');
const path = require('path');
const fs = require('fs-extra');
const package_json = require('../../../../package.json');
const NATS_VERSION = package_json.engines['nats-server'];
const needle = require('needle');
const stream_zip = require('node-stream-zip');

describe('test checkGoVersion', () => {
	const sandbox = sinon.createSandbox();
	let check_go_version = installer.__get__('checkGoVersion');

	it('test go not available', async () => {
		let cmd_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
			throw Error('no go');
		});

		// eslint-disable-next-line radar/no-duplicate-string
		let cmd_restore = installer.__set__('runCommand', cmd_stub);
		let semver_spy = sandbox.spy(installer.__get__('semver'), 'gte');
		let console_log_spy = sandbox.spy(console, 'log');

		let error;
		try {
			await check_go_version();
		} catch (e) {
			error = e;
		}
		expect(error).is.not.equal(undefined);
		expect(error.message).to.equal(
			'go does not appear to be installed or is not in the PATH, cannot install clustering dependencies.'
		);

		expect(cmd_stub.callCount).to.equal(1);
		expect(cmd_stub.firstCall.args).to.eql(['go version', undefined]);
		let cmd_err;
		try {
			await cmd_stub.firstCall.returnValue;
		} catch (e) {
			cmd_err = e;
		}
		expect(cmd_err).to.not.equal(undefined);
		expect(cmd_err.message).to.equal('no go');

		expect(console_log_spy.callCount).to.equal(1);
		expect(semver_spy.callCount).to.equal(0);

		cmd_restore();
		sandbox.restore();
	});

	it('test go is older version than expected', async () => {
		let cmd_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
			return '1.0.0';
		});

		let cmd_restore = installer.__set__('runCommand', cmd_stub);
		let go_version_restore = installer.__set__('REQUIRED_GO_VERSION', '1.17.6');
		let semver_spy = sandbox.spy(installer.__get__('semver'), 'gte');

		let console_log_spy = sandbox.spy(console, 'log');

		let error;
		try {
			await check_go_version();
		} catch (e) {
			error = e;
		}
		expect(error).is.not.equal(undefined);
		expect(error.message).to.equal(`go version 1.17.6 or higher must be installed.`);

		expect(cmd_stub.callCount).to.equal(1);
		expect(cmd_stub.firstCall.args).to.eql(['go version', undefined]);
		let cmd_result = await cmd_stub.firstCall.returnValue;
		expect(cmd_result).to.equal('1.0.0');

		expect(console_log_spy.callCount).to.equal(1);
		expect(semver_spy.callCount).to.equal(1);
		expect(semver_spy.firstCall.args).to.eql(['1.0.0', '1.17.6']);
		expect(semver_spy.firstCall.returnValue).to.eql(false);

		cmd_restore();
		go_version_restore();
		sandbox.restore();
	});

	it('test go is same version as expected', async () => {
		let cmd_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
			return '1.17.6';
		});

		let cmd_restore = installer.__set__('runCommand', cmd_stub);
		let go_version_restore = installer.__set__('REQUIRED_GO_VERSION', '1.17.6');
		let semver_spy = sandbox.spy(installer.__get__('semver'), 'gte');

		let console_log_spy = sandbox.spy(console, 'log');

		let error;
		try {
			await check_go_version();
		} catch (e) {
			error = e;
		}
		expect(error).is.equal(undefined);

		expect(cmd_stub.callCount).to.equal(1);
		expect(cmd_stub.firstCall.args).to.eql(['go version', undefined]);
		let cmd_result = await cmd_stub.firstCall.returnValue;
		expect(cmd_result).to.equal('1.17.6');

		expect(console_log_spy.callCount).to.equal(2);
		expect(semver_spy.callCount).to.equal(1);
		expect(semver_spy.firstCall.args).to.eql(['1.17.6', '1.17.6']);
		expect(semver_spy.firstCall.returnValue).to.eql(true);

		cmd_restore();
		go_version_restore();
		sandbox.restore();
	});

	it('test go is greater version than expected', async () => {
		let cmd_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
			return '2.0.0';
		});

		let cmd_restore = installer.__set__('runCommand', cmd_stub);
		let go_version_restore = installer.__set__('REQUIRED_GO_VERSION', '1.17.6');
		let semver_spy = sandbox.spy(installer.__get__('semver'), 'gte');

		let console_log_spy = sandbox.spy(console, 'log');

		let error;
		try {
			await check_go_version();
		} catch (e) {
			error = e;
		}
		expect(error).is.equal(undefined);

		expect(cmd_stub.callCount).to.equal(1);
		expect(cmd_stub.firstCall.args).to.eql(['go version', undefined]);
		let cmd_result = await cmd_stub.firstCall.returnValue;
		expect(cmd_result).to.equal('2.0.0');

		expect(console_log_spy.callCount).to.equal(2);
		expect(semver_spy.callCount).to.equal(1);
		expect(semver_spy.firstCall.args).to.eql(['2.0.0', '1.17.6']);
		expect(semver_spy.firstCall.returnValue).to.eql(true);

		cmd_restore();
		go_version_restore();
		sandbox.restore();
	});
});

describe('test extractNATSServer function', () => {
	const sandbox = sinon.createSandbox();
	let extract = installer.__get__('extractNATSServer');

	it('test function', async () => {
		let zip_path_restore = installer.__set__('ZIP_PATH', '/tmp/nats-server.zip');
		let deps_restore = installer.__set__('DEPENDENCIES_PATH', '/tmp/');

		let zip_stub = sandbox.stub().callsFake((arg) => {
			return {
				entries: () => {
					return { 'nats-server-src': '' };
				},
				extract: () => {
					return 321;
				},
				close: () => {},
			};
		});

		let stream_zip_restore = installer.__set__('StreamZip', { async: zip_stub });
		let console_log_spy = sandbox.spy(console, 'log');
		let path_join_spy = sandbox.spy(installer.__get__('path'), 'join');

		let result = await extract();
		expect(result).to.equal(`${path.sep}tmp${path.sep}nats-server-src`);
		expect(console_log_spy.callCount).to.equal(2);
		expect(console_log_spy.firstCall.args).to.eql([chalk.green('Extracting NATS Server source code.')]);
		expect(console_log_spy.secondCall.args).to.eql([chalk.green('Extracted 321 entries.')]);
		expect(path_join_spy.callCount).to.equal(1);
		expect(path_join_spy.firstCall.args).to.eql(['/tmp/', 'nats-server-src']);

		zip_path_restore();
		deps_restore();
		stream_zip_restore();
		sandbox.restore();
	});
});

describe('test cleanUp function', () => {
	const sandbox = sinon.createSandbox();
	let cleanup = installer.__get__('cleanUp');
	it('test function', async () => {
		let fs_move_stub = sandbox.stub().callsFake(async (path1, path2, opt) => {});
		let fs_remove_stub = sandbox.stub().callsFake(async (path) => {});
		let fs_restore = installer.__set__('fs', {
			move: fs_move_stub,
			remove: fs_remove_stub,
		});

		let nats_server_path_restore = installer.__set__('NATS_SERVER_BINARY_PATH', '/tmp/nats-server');
		let deps_path_restore = installer.__set__('DEPENDENCIES_PATH', '/tmp/');
		let path_join_spy = sandbox.spy(installer.__get__('path'), 'join');

		await cleanup('/tmp/nats-server-src/');
		expect(path_join_spy.callCount).to.equal(2);
		expect(path_join_spy.firstCall.args).to.eql([
			'/tmp/nats-server-src/',
			`nats-server${process.platform === 'win32' ? '.exe' : ''}`,
		]);
		expect(path_join_spy.secondCall.args).to.eql(['/tmp/', 'pkg']);

		expect(fs_move_stub.callCount).to.equal(1);
		let args = fs_move_stub.firstCall.args;
		if (args[0].endsWith('.exe')) args[0] = args[0].slice(0, -4); // normalize windows
		expect(fs_move_stub.firstCall.args).to.eql([
			`${path.sep}tmp${path.sep}nats-server-src${path.sep}nats-server`,
			'/tmp/nats-server',
			{ overwrite: true },
		]);

		expect(fs_remove_stub.callCount).to.equal(2);
		expect(fs_remove_stub.firstCall.args).to.eql(['/tmp/nats-server-src/']);
		expect(fs_remove_stub.secondCall.args).to.eql([`${path.sep}tmp${path.sep}pkg`]);

		nats_server_path_restore();
		fs_restore();
		deps_path_restore();
		sandbox.restore();
	});
});

describe('test installer function', () => {
	let sandbox;
	let installer_func = installer.__get__('installer');
	let console_log_spy;
	let console_error_spy;
	let nats_version_restore;
	const required_nats_version = '2.8.0';
	const required_nats_version_restore = installer.__set__('REQUIRED_NATS_SERVER_VERSION', required_nats_version);

	before(() => {
		sandbox = sinon.createSandbox();
		console_log_spy = sandbox.spy(console, 'log');
		console_error_spy = sandbox.spy(console, 'error');
	});

	afterEach(() => {
		sandbox.reset();
	});

	after(() => {
		required_nats_version_restore();
		sandbox.restore();
	});

	it('test already installed', async () => {
		let nats_installed_stub = sandbox.stub().callsFake(async () => {
			return true;
		});

		let check_go_stub = sandbox.stub();
		let extract_stub = sandbox.stub();
		let run_cmd_stub = sandbox.stub();
		let cleanup_stub = sandbox.stub();

		let check_nats_installed_restore = installer.__set__('checkNATSServerInstalled', nats_installed_stub);
		let check_go_restore = installer.__set__('checkGoVersion', check_go_stub);
		let extract_restore = installer.__set__('extractNATSServer', extract_stub);
		let run_cmd_restore = installer.__set__('runCommand', run_cmd_stub);
		let cleanup_restore = installer.__set__('cleanUp', cleanup_stub);

		await installer_func();
		expect(console_log_spy.callCount).to.equal(2);
		expect(console_error_spy.callCount).to.equal(0);
		expect(console_log_spy.args).to.eql([
			[chalk.green('****Starting install of NATS Server.****')],
			[chalk.green(`****NATS Server v${required_nats_version} installed.****`)],
		]);

		expect(nats_installed_stub.callCount).to.equal(1);
		expect(check_go_stub.callCount).to.equal(0);
		expect(extract_stub.callCount).to.equal(0);
		expect(run_cmd_stub.callCount).to.equal(0);
		expect(cleanup_stub.callCount).to.equal(0);

		check_nats_installed_restore();
		check_go_restore();
		extract_restore();
		run_cmd_restore();
		cleanup_restore();
	});

	it('test already not installed, go check fails', async () => {
		const process_exit_stub = sandbox.stub(process, 'exit');

		let nats_installed_stub = sandbox.stub().callsFake(async () => {
			return false;
		});

		let check_go_stub = sandbox.stub().callsFake(async () => {
			throw Error('no go');
		});

		let extract_stub = sandbox.stub();
		let run_cmd_stub = sandbox.stub();
		let cleanup_stub = sandbox.stub();
		let download_stub = sandbox.stub().callsFake(async () => {
			throw Error('bad download');
		});

		let check_nats_installed_restore = installer.__set__('checkNATSServerInstalled', nats_installed_stub);
		let check_go_restore = installer.__set__('checkGoVersion', check_go_stub);
		let extract_restore = installer.__set__('extractNATSServer', extract_stub);
		let run_cmd_restore = installer.__set__('runCommand', run_cmd_stub);
		let cleanup_restore = installer.__set__('cleanUp', cleanup_stub);
		let download_restore = installer.__set__('downloadNATSServer', download_stub);

		await installer_func();
		expect(console_log_spy.callCount).to.equal(4);
		expect(console_error_spy.callCount).to.equal(2);
		expect(console_log_spy.args[0]).to.eql([chalk.green('****Starting install of NATS Server.****')]);
		expect(console_error_spy.args[1]).to.eql([chalk.red('no go')]);
		expect(process_exit_stub.called).to.be.true;
		expect(nats_installed_stub.callCount).to.equal(1);
		expect(check_go_stub.callCount).to.equal(1);

		check_nats_installed_restore();
		check_go_restore();
		extract_restore();
		run_cmd_restore();
		cleanup_restore();
		download_restore();
		process_exit_stub.restore();
	});

	it('test happy path, no download', async () => {
		let nats_installed_stub = sandbox.stub().callsFake(async () => {
			return false;
		});

		let check_go_stub = sandbox.stub().callsFake(async () => {});

		let extract_stub = sandbox.stub().callsFake(async () => {
			return '/tmp/nats-server-2.7.1/';
		});
		let run_cmd_stub = sandbox.stub().callsFake(async (cmd, cwd) => {});
		let cleanup_stub = sandbox.stub().callsFake(async (folder) => {});
		let download_stub = sandbox.stub().callsFake(async () => {
			throw Error('bad download');
		});

		let check_nats_installed_restore = installer.__set__('checkNATSServerInstalled', nats_installed_stub);
		let check_go_restore = installer.__set__('checkGoVersion', check_go_stub);
		let extract_restore = installer.__set__('extractNATSServer', extract_stub);
		let run_cmd_restore = installer.__set__('runCommand', run_cmd_stub);
		let cleanup_restore = installer.__set__('cleanUp', cleanup_stub);
		let download_restore = installer.__set__('downloadNATSServer', download_stub);

		await installer_func();
		expect(console_log_spy.callCount).to.equal(4);
		expect(console_error_spy.callCount).to.equal(1);
		expect(console_log_spy.args).to.eql([
			[chalk.green('****Starting install of NATS Server.****')],
			[chalk.green('Building NATS Server binary.')],
			[chalk.green('Building NATS Server binary complete.')],
			[chalk.green(`****NATS Server v${required_nats_version} is installed.****`)],
		]);

		expect(nats_installed_stub.callCount).to.equal(1);
		expect(check_go_stub.callCount).to.equal(1);
		expect(extract_stub.callCount).to.equal(1);
		expect(run_cmd_stub.callCount).to.equal(1);
		expect(cleanup_stub.callCount).to.equal(1);

		check_nats_installed_restore();
		check_go_restore();
		extract_restore();
		run_cmd_restore();
		cleanup_restore();
		download_restore();
	});
});

describe('test checkNATSServerInstalled', () => {
	const check_server_sandbox = sinon.createSandbox();
	let check_installed = installer.__get__('checkNATSServerInstalled');

	it('test nats-server binary does not exist', async () => {
		let access_stub = check_server_sandbox.stub().callsFake(async (path) => {
			throw Error('ENONT');
		});

		let cmd_stub = check_server_sandbox.stub();
		let semver_stub = check_server_sandbox.spy(installer.__get__('semver'), 'eq');

		let fs_restore = installer.__set__('fs', {
			access: access_stub,
		});
		let cmd_restore = installer.__set__('runCommand', cmd_stub);

		let result = await check_installed();
		expect(result).to.equal(false);
		expect(access_stub.callCount).to.equal(1);
		let expected_err;
		try {
			let rez = await access_stub.returnValues[0];
		} catch (e) {
			expected_err = e;
		}
		expect(expected_err.message).to.equal('ENONT');
		expect(cmd_stub.callCount).to.equal(0);
		expect(semver_stub.callCount).to.equal(0);
		fs_restore();
		cmd_restore();
		check_server_sandbox.restore();
	});

	it('test nats-server binary does exist, wrong version of nats-server', async () => {
		let access_stub = check_server_sandbox.stub().callsFake(async (path) => {
			return;
		});

		let cmd_stub = check_server_sandbox.stub().callsFake(async (cmd, cwd) => {
			return 'nats-server v2.7.0';
		});

		let nats_version_restore = installer.__set__('REQUIRED_NATS_SERVER_VERSION', '2.7.2');

		let fs_restore = installer.__set__('fs', {
			access: access_stub,
		});
		let cmd_restore = installer.__set__('runCommand', cmd_stub);
		let semver_spy = check_server_sandbox.spy(installer.__get__('semver'), 'eq');

		let result = await check_installed();
		expect(result).to.equal(false);
		expect(access_stub.callCount).to.equal(1);
		let expected_err;
		let rez;
		try {
			rez = await access_stub.returnValues[0];
		} catch (e) {
			expected_err = e;
		}
		expect(expected_err).to.equal(undefined);
		expect(rez).to.equal(undefined);
		expect(cmd_stub.callCount).to.equal(1);

		let cmd_result = await cmd_stub.returnValues[0];
		expect(cmd_result).to.equal('nats-server v2.7.0');

		expect(semver_spy.callCount).to.equal(1);
		expect(semver_spy.returnValues[0]).to.equal(false);
		fs_restore();
		cmd_restore();
		nats_version_restore();
		check_server_sandbox.restore();
	});

	it('test nats-server binary does exist, same version of nats-server returned as expected', async () => {
		let access_stub = check_server_sandbox.stub().callsFake(async (path) => {
			return;
		});

		let cmd_stub = check_server_sandbox.stub().callsFake(async (cmd, cwd) => {
			return 'nats-server v2.7.2';
		});

		let nats_version_restore = installer.__set__('REQUIRED_NATS_SERVER_VERSION', '2.7.2');

		let fs_restore = installer.__set__('fs', {
			access: access_stub,
		});
		let cmd_restore = installer.__set__('runCommand', cmd_stub);
		let semver_spy = check_server_sandbox.spy(installer.__get__('semver'), 'eq');

		let result = await check_installed();
		expect(result).to.equal(true);
		expect(access_stub.callCount).to.equal(1);
		let expected_err;
		let rez;
		try {
			rez = await access_stub.returnValues[0];
		} catch (e) {
			expected_err = e;
		}
		expect(expected_err).to.equal(undefined);
		expect(rez).to.equal(undefined);
		expect(cmd_stub.callCount).to.equal(1);

		let cmd_result = await cmd_stub.returnValues[0];
		expect(cmd_result).to.equal('nats-server v2.7.2');

		expect(semver_spy.callCount).to.equal(1);
		expect(semver_spy.returnValues[0]).to.equal(true);
		fs_restore();
		cmd_restore();
		nats_version_restore();
		check_server_sandbox.restore();
	});

	it('test nats-server binary does exist, greater version of nats-server returned as expected', async () => {
		let access_stub = check_server_sandbox.stub().callsFake(async (path) => {
			return;
		});

		let cmd_stub = check_server_sandbox.stub().callsFake(async (cmd, cwd) => {
			return 'nats-server v2.7.3';
		});

		let nats_version_restore = installer.__set__('REQUIRED_NATS_SERVER_VERSION', '2.7.2');

		let fs_restore = installer.__set__('fs', {
			access: access_stub,
		});
		let cmd_restore = installer.__set__('runCommand', cmd_stub);
		let semver_spy = check_server_sandbox.spy(installer.__get__('semver'), 'eq');

		let result = await check_installed();
		expect(result).to.equal(false);
		expect(access_stub.callCount).to.equal(1);
		let expected_err;
		let rez;
		try {
			rez = await access_stub.returnValues[0];
		} catch (e) {
			expected_err = e;
		}
		expect(expected_err).to.equal(undefined);
		expect(rez).to.equal(undefined);
		expect(cmd_stub.callCount).to.equal(1);

		let cmd_result = await cmd_stub.returnValues[0];
		expect(cmd_result).to.equal('nats-server v2.7.3');

		expect(semver_spy.callCount).to.equal(1);
		expect(semver_spy.returnValues[0]).to.equal(false);
		fs_restore();
		cmd_restore();
		nats_version_restore();
		check_server_sandbox.restore();
	});
});

describe('test runCommand function', () => {
	const run_command_sandbox = sinon.createSandbox();
	let run_command = installer.__get__('runCommand');

	it('test function, with error', async () => {
		let exec_stub = run_command_sandbox.stub().callsFake(async (cmd, opts) => {
			return { stderr: 'this is bad\n' };
		});

		let exec_restore = installer.__set__('exec', exec_stub);

		let error;
		try {
			await run_command('cool command');
		} catch (e) {
			error = e;
		}

		expect(error.message).to.equal('this is bad');
		expect(exec_stub.callCount).to.equal(1);
		expect(exec_stub.firstCall.args).to.eql(['cool command', { cwd: undefined }]);

		exec_restore();
		run_command_sandbox.restore();
	});

	it('test function, without error', async () => {
		let exec_stub = run_command_sandbox.stub().callsFake(async (cmd, opts) => {
			return { stdout: 'all good\n' };
		});

		let exec_restore = installer.__set__('exec', exec_stub);

		let error;
		let result;
		try {
			result = await run_command('cool command', '/tmp/nats-server-2.7.1/');
		} catch (e) {
			error = e;
		}

		expect(error).to.equal(undefined);
		expect(result).to.equal('all good');
		expect(exec_stub.callCount).to.equal(1);
		expect(exec_stub.firstCall.args).to.eql(['cool command', { cwd: '/tmp/nats-server-2.7.1/' }]);

		exec_restore();
		run_command_sandbox.restore();
	});
});

describe('test downloadNATSServer function', () => {
	const sandbox = sinon.createSandbox();
	const dependency_path = path.join(test_utils.getMockTestPath(), 'dependencies');
	let download_nats = installer.__get__('downloadNATSServer');
	let deps_path_restore;
	beforeEach(async () => {
		await fs.mkdirp(dependency_path);
		deps_path_restore = installer.__set__('DEPENDENCIES_PATH', dependency_path);
		sandbox.restore();
	});

	afterEach(async () => {
		await fs.remove(dependency_path);
		deps_path_restore();
	});

	it('test happy path, simulate linux x64', async () => {
		// spy fs.ensureFile, fs.remove, fs.chmod
		let og_platform = process.platform;
		let og_arch = process.arch;
		if (og_platform == 'win32') return;
		Object.defineProperty(process, 'platform', { value: 'linux' });
		Object.defineProperty(process, 'arch', { value: 'x64' });

		let fs_ensure_file_spy = sandbox.spy(installer.__get__('fs'), 'ensureFile');
		let fs_remove_spy = sandbox.spy(installer.__get__('fs'), 'remove');
		let fs_chmod_spy = sandbox.spy(installer.__get__('fs'), 'chmod');

		let needle_spy = sandbox.spy(needle, 'request');

		let stream_zip_async_spy = sandbox.spy(stream_zip, 'async');

		let err;
		try {
			await download_nats();
		} catch (e) {
			err = e;
		}
		let zip_path = path.join(dependency_path, 'linux-x64', 'linux-amd64.zip');
		expect(err).to.equal(undefined);
		expect(fs_ensure_file_spy.callCount).to.equal(1);
		expect(fs_ensure_file_spy.getCall(0).args).to.eql([zip_path]);
		expect(fs_remove_spy.callCount).to.equal(1);
		expect(fs_remove_spy.getCall(0).args).to.eql([zip_path]);
		expect(needle_spy.callCount).to.equal(1);
		expect(needle_spy.getCall(0).args[1]).to.eql(
			`https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}/nats-server-v${NATS_VERSION}-linux-amd64.zip`
		);
		expect(needle_spy.getCall(0).args[3]).to.eql({ output: zip_path, follow_max: 5 });

		expect(stream_zip_async_spy.callCount).to.equal(1);
		expect(stream_zip_async_spy.getCall(0).args).to.eql([{ file: zip_path }]);
		expect(fs_chmod_spy.callCount).to.equal(1);
		expect(fs_chmod_spy.getCall(0).args).to.eql([path.join(dependency_path, 'linux-x64', 'nats-server'), 0o777]);

		let binary_exists = await fs.pathExists(path.join(dependency_path, 'linux-x64', 'nats-server'));
		expect(binary_exists).to.equal(true);

		let zip_exists = await fs.pathExists(zip_path);
		expect(zip_exists).to.equal(false);

		Object.defineProperty(process, 'platform', { value: og_platform });
		Object.defineProperty(process, 'arch', { value: og_arch });
	}).timeout(20000);

	it('test happy path, simulate darwin arm64', async () => {
		// spy fs.ensureFile, fs.remove, fs.chmod
		let og_platform = process.platform;
		let og_arch = process.arch;
		Object.defineProperty(process, 'platform', { value: 'darwin' });
		Object.defineProperty(process, 'arch', { value: 'arm64' });

		let fs_ensure_file_spy = sandbox.spy(installer.__get__('fs'), 'ensureFile');
		let fs_remove_spy = sandbox.spy(installer.__get__('fs'), 'remove');
		let fs_chmod_spy = sandbox.spy(installer.__get__('fs'), 'chmod');

		let needle_spy = sandbox.spy(needle, 'request');

		let stream_zip_async_spy = sandbox.spy(stream_zip, 'async');

		let err;
		try {
			await download_nats();
		} catch (e) {
			err = e;
		}
		let zip_path = path.join(dependency_path, 'darwin-arm64', 'darwin-arm64.zip');
		expect(err).to.equal(undefined);
		expect(fs_ensure_file_spy.callCount).to.equal(1);
		expect(fs_ensure_file_spy.getCall(0).args).to.eql([zip_path]);
		expect(fs_remove_spy.callCount).to.equal(1);
		expect(fs_remove_spy.getCall(0).args).to.eql([zip_path]);
		expect(needle_spy.callCount).to.equal(1);
		expect(needle_spy.getCall(0).args[1]).to.eql(
			`https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}/nats-server-v${NATS_VERSION}-darwin-arm64.zip`
		);
		expect(needle_spy.getCall(0).args[3]).to.eql({ output: zip_path, follow_max: 5 });

		expect(stream_zip_async_spy.callCount).to.equal(1);
		expect(stream_zip_async_spy.getCall(0).args).to.eql([{ file: zip_path }]);
		expect(fs_chmod_spy.callCount).to.equal(1);
		expect(fs_chmod_spy.getCall(0).args).to.eql([path.join(dependency_path, 'darwin-arm64', 'nats-server'), 0o777]);

		let binary_exists = await fs.pathExists(path.join(dependency_path, 'darwin-arm64', 'nats-server'));
		expect(binary_exists).to.equal(true);

		let zip_exists = await fs.pathExists(zip_path);
		expect(zip_exists).to.equal(false);

		Object.defineProperty(process, 'platform', { value: og_platform });
		Object.defineProperty(process, 'arch', { value: og_arch });
	}).timeout(20000);

	it('test happy path, win32 x64', async () => {
		let fs_ensure_file_spy = sandbox.spy(installer.__get__('fs'), 'ensureFile');
		let fs_remove_spy = sandbox.spy(installer.__get__('fs'), 'remove');
		let fs_chmod_spy = sandbox.spy(installer.__get__('fs'), 'chmod');
		let needle_spy = sandbox.spy(needle, 'request');
		let stream_zip_async_spy = sandbox.spy(stream_zip, 'async');

		let err;
		try {
			await download_nats('win32', 'x64');
		} catch (e) {
			err = e;
		}
		let zip_path = path.join(dependency_path, 'win32-x64', 'windows-amd64.zip');
		expect(err).to.equal(undefined);
		expect(fs_ensure_file_spy.callCount).to.equal(1);
		expect(fs_ensure_file_spy.getCall(0).args).to.eql([zip_path]);
		expect(fs_remove_spy.callCount).to.equal(1);
		expect(fs_remove_spy.getCall(0).args).to.eql([zip_path]);
		expect(needle_spy.callCount).to.equal(1);
		expect(needle_spy.getCall(0).args[1]).to.eql(
			`https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}/nats-server-v${NATS_VERSION}-windows-amd64.zip`
		);
		expect(needle_spy.getCall(0).args[3]).to.eql({ output: zip_path, follow_max: 5 });

		expect(stream_zip_async_spy.callCount).to.equal(1);
		expect(stream_zip_async_spy.getCall(0).args).to.eql([{ file: zip_path }]);
		expect(fs_chmod_spy.callCount).to.equal(1);
		expect(fs_chmod_spy.getCall(0).args).to.eql([path.join(dependency_path, 'win32-x64', 'nats-server.exe'), 0o777]);

		let binary_exists = await fs.pathExists(path.join(dependency_path, 'win32-x64', 'nats-server.exe'));
		expect(binary_exists).to.equal(true);

		let zip_exists = await fs.pathExists(zip_path);
		expect(zip_exists).to.equal(false);
	}).timeout(20000);

	it('test unknown architecture', async () => {
		let err;
		try {
			await download_nats('blerg', '??');
		} catch (e) {
			err = e;
		}

		expect(err.message).to.equal('unknown platform - architecture: blerg-??');
	});
});
