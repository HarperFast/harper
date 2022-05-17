'use strict';

const rewire = require('rewire');
const installer = rewire('../../../../server/nats/utility/installNATSServer');
const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const chalk = require('chalk');

describe('test checkGoVersion', () => {
	const sandbox = sinon.createSandbox();
	let check_go_version = installer.__get__('checkGoVersion');

	it('test go not available', async () => {
		let cmd_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
			throw Error('no go');
		});

		// eslint-disable-next-line radar/no-duplicate-string
		let cmd_restore = installer.__set__('nats_utils.runCommand', cmd_stub);
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
		expect(cmd_stub.firstCall.args).to.eql(['go version | { read _ _ v _; echo ${v#go}; }', undefined]);
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

		let cmd_restore = installer.__set__('nats_utils.runCommand', cmd_stub);
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
		expect(cmd_stub.firstCall.args).to.eql(['go version | { read _ _ v _; echo ${v#go}; }', undefined]);
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

		let cmd_restore = installer.__set__('nats_utils.runCommand', cmd_stub);
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
		expect(cmd_stub.firstCall.args).to.eql(['go version | { read _ _ v _; echo ${v#go}; }', undefined]);
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

		let cmd_restore = installer.__set__('nats_utils.runCommand', cmd_stub);
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
		expect(cmd_stub.firstCall.args).to.eql(['go version | { read _ _ v _; echo ${v#go}; }', undefined]);
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
		expect(result).to.equal('/tmp/nats-server-src');
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

		let nats_server_path_restore = installer.__set__('NATS_SERVER_BINARY', '/tmp/nats-server');
		let deps_path_restore = installer.__set__('DEPENDENCIES_PATH', '/tmp/');
		let path_join_spy = sandbox.spy(installer.__get__('path'), 'join');

		await cleanup('/tmp/nats-server-src/');
		expect(path_join_spy.callCount).to.equal(2);
		expect(path_join_spy.firstCall.args).to.eql(['/tmp/nats-server-src/', 'nats-server']);
		expect(path_join_spy.secondCall.args).to.eql(['/tmp/', 'pkg']);

		expect(fs_move_stub.callCount).to.equal(1);
		expect(fs_move_stub.firstCall.args).to.eql([
			'/tmp/nats-server-src/nats-server',
			'/tmp/nats-server',
			{ overwrite: true },
		]);

		expect(fs_remove_stub.callCount).to.equal(2);
		expect(fs_remove_stub.firstCall.args).to.eql(['/tmp/nats-server-src/']);
		expect(fs_remove_stub.secondCall.args).to.eql(['/tmp/pkg']);

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

		let check_nats_installed_restore = installer.__set__('nats_utils.checkNATSServerInstalled', nats_installed_stub);
		let check_go_restore = installer.__set__('checkGoVersion', check_go_stub);
		let extract_restore = installer.__set__('extractNATSServer', extract_stub);
		let run_cmd_restore = installer.__set__('nats_utils.runCommand', run_cmd_stub);
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
		let nats_installed_stub = sandbox.stub().callsFake(async () => {
			return false;
		});

		let check_go_stub = sandbox.stub().callsFake(async () => {
			throw Error('no go');
		});

		let extract_stub = sandbox.stub();
		let run_cmd_stub = sandbox.stub();
		let cleanup_stub = sandbox.stub();

		let check_nats_installed_restore = installer.__set__('nats_utils.checkNATSServerInstalled', nats_installed_stub);
		let check_go_restore = installer.__set__('checkGoVersion', check_go_stub);
		let extract_restore = installer.__set__('extractNATSServer', extract_stub);
		let run_cmd_restore = installer.__set__('nats_utils.runCommand', run_cmd_stub);
		let cleanup_restore = installer.__set__('cleanUp', cleanup_stub);

		await installer_func();
		expect(console_log_spy.callCount).to.equal(1);
		expect(console_error_spy.callCount).to.equal(1);
		expect(console_log_spy.args).to.eql([[chalk.green('****Starting install of NATS Server.****')]]);
		expect(console_error_spy.args).to.eql([[chalk.red('no go')]]);

		expect(nats_installed_stub.callCount).to.equal(1);
		expect(check_go_stub.callCount).to.equal(1);
		expect(extract_stub.callCount).to.equal(0);
		expect(run_cmd_stub.callCount).to.equal(0);
		expect(cleanup_stub.callCount).to.equal(0);

		check_nats_installed_restore();
		check_go_restore();
		extract_restore();
		run_cmd_restore();
		cleanup_restore();
	});

	it('test happy path', async () => {
		let nats_installed_stub = sandbox.stub().callsFake(async () => {
			return false;
		});

		let check_go_stub = sandbox.stub().callsFake(async () => {});

		let extract_stub = sandbox.stub().callsFake(async () => {
			return '/tmp/nats-server-2.7.1/';
		});
		let run_cmd_stub = sandbox.stub().callsFake(async (cmd, cwd) => {});
		let cleanup_stub = sandbox.stub().callsFake(async (folder) => {});

		let check_nats_installed_restore = installer.__set__('nats_utils.checkNATSServerInstalled', nats_installed_stub);
		let check_go_restore = installer.__set__('checkGoVersion', check_go_stub);
		let extract_restore = installer.__set__('extractNATSServer', extract_stub);
		let run_cmd_restore = installer.__set__('nats_utils.runCommand', run_cmd_stub);
		let cleanup_restore = installer.__set__('cleanUp', cleanup_stub);

		await installer_func();
		expect(console_log_spy.callCount).to.equal(4);
		expect(console_error_spy.callCount).to.equal(0);
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
	});
});
