'use strict';

const path = require('path');
const fs = require('fs-extra');
const assert = require('assert');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const rewire = require('rewire');
const npm_utils = rewire('../../utility/npmUtilities');
const env_mgr = require('../../utility/environment/environmentManager');
const test_utils = require('../test_utils');
test_utils.changeProcessToBinDir();
const COOL_PROJECT_NAME = 'cool project';
const BAD_PROJECT_NAME = 'bad project';
const PACKAGE_JSON = 'package.json';
const MOCK_CF_DIR_PATH = path.join(test_utils.getMockTestPath(), 'cf');
const COOL_PROJECT_PATH = path.join(MOCK_CF_DIR_PATH, COOL_PROJECT_NAME);
const COOL_PACKAGE_JSON_PATH = path.join(COOL_PROJECT_PATH, PACKAGE_JSON);
const BAD_PROJECT_PATH = path.join(MOCK_CF_DIR_PATH, BAD_PROJECT_NAME);
const BAD_PACKAGE_JSON_PATH = path.join(BAD_PROJECT_PATH, PACKAGE_JSON);
const COOL_PROJECT_PACKAGE_JSON = {
	name: 'cool',
	version: '1.0.0',
	description: 'My cool project',
	dependencies: { dayjs: '1.11.3' },
};
const BAD_PROJECT_PACKAGE_JSON = {
	name: 'bad',
	version: '1.0.0',
	description: 'My bad project',
	dependencies: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzddddddd',
};

describe('test runCommand', () => {
	const sandbox = sinon.createSandbox();
	const run_command = npm_utils.__get__('runCommand');

	afterEach(() => {
		sandbox.restore();
	});

	it('test stderr is not null', async () => {
		let exec_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
			return { stderr: 'bad stuff' };
		});

		let exec_restore = npm_utils.__set__('p_exec', exec_stub);
		let error;
		try {
			await run_command('npm install');
		} catch (e) {
			error = e;
		}
		expect(error).is.undefined;
		exec_restore();
	});

	it('test stderr is null', async () => {
		let exec_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
			return { stdout: 'good stuff' };
		});

		let exec_restore = npm_utils.__set__('p_exec', exec_stub);
		let error;
		let result;
		try {
			result = await run_command('npm install');
		} catch (e) {
			error = e;
		}
		expect(error).is.equal(undefined);
		expect(result).is.equal('good stuff');
		exec_restore();
	});
});

describe('test checkNPMInstalled function', () => {
	const sandbox = sinon.createSandbox();
	const check_npm = npm_utils.__get__('checkNPMInstalled');

	afterEach(() => {
		sandbox.restore();
	});

	it('test happy path', async () => {
		let exec_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
			return { stdout: '6.14.17' };
		});

		let exec_restore = npm_utils.__set__('p_exec', exec_stub);

		let error;
		let result;
		try {
			result = await check_npm();
		} catch (e) {
			error = e;
		}

		expect(error).is.equal(undefined);
		expect(result).is.equal(true);
		exec_restore();
	});

	it('test no npm', async () => {
		let exec_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
			return { stderr: 'no npm' };
		});

		let exec_restore = npm_utils.__set__('p_exec', exec_stub);

		let error;
		let result;
		try {
			result = await check_npm();
		} catch (e) {
			error = e;
		}

		expect(error).is.be.undefined;
		exec_restore();
	});
});

describe('test checkProjectPaths function', () => {
	const sandbox = sinon.createSandbox();
	const check_project_paths = npm_utils.__get__('checkProjectPaths');

	afterEach(() => {
		sandbox.restore();
	});

	it('test validation', async () => {
		let error;
		try {
			await check_project_paths();
		} catch (e) {
			error = e;
		}
		expect(error.message).to.equal(`projects argument must be an array with at least 1 element`);

		error = undefined;
		try {
			await check_project_paths(null);
		} catch (e) {
			error = e;
		}
		expect(error.message).to.equal(`projects argument must be an array with at least 1 element`);

		error = undefined;
		try {
			await check_project_paths('cool project');
		} catch (e) {
			error = e;
		}
		expect(error.message).to.equal(`projects argument must be an array with at least 1 element`);

		error = undefined;
		try {
			await check_project_paths([]);
		} catch (e) {
			error = e;
		}
		expect(error.message).to.equal(`projects argument must be an array with at least 1 element`);
	});

	it('test one existing project path', async () => {
		let path_exists_stub = sandbox.stub().callsFake(async (path) => {
			return true;
		});

		let cf_routes_dir_restore = npm_utils.__set__('CF_ROUTES_DIR', MOCK_CF_DIR_PATH);
		let path_exists_restore = npm_utils.__set__('fs', { pathExists: path_exists_stub });
		let path_join_spy = sandbox.spy(npm_utils.__get__('path'), 'join');

		let error;
		try {
			await check_project_paths([COOL_PROJECT_NAME]);
		} catch (e) {
			error = e;
		}
		expect(error).to.equal(undefined);
		expect(path_exists_stub.callCount).to.equal(2);
		expect(path_exists_stub.firstCall.args).to.eql([COOL_PROJECT_PATH]);
		expect(path_exists_stub.secondCall.args).to.eql([COOL_PACKAGE_JSON_PATH]);

		expect(path_join_spy.callCount).to.equal(2);
		expect(path_join_spy.firstCall.args).to.eql([`${MOCK_CF_DIR_PATH}`, COOL_PROJECT_NAME]);
		expect(path_join_spy.secondCall.args).to.eql([COOL_PROJECT_PATH, PACKAGE_JSON]);

		path_exists_restore();
		cf_routes_dir_restore();
	});

	it('test one non-existing project path', async () => {
		let path_exists_stub = sandbox.stub();

		path_exists_stub.onCall(0).callsFake(async (path) => {
			return true;
		});
		path_exists_stub.onCall(1).callsFake(async (path) => {
			return true;
		});
		path_exists_stub.onCall(2).callsFake(async (path) => {
			return false;
		});

		let cf_routes_dir_restore = npm_utils.__set__('CF_ROUTES_DIR', MOCK_CF_DIR_PATH);
		let path_exists_restore = npm_utils.__set__('fs', { pathExists: path_exists_stub });
		let path_join_spy = sandbox.spy(npm_utils.__get__('path'), 'join');

		let error;
		try {
			await check_project_paths([COOL_PROJECT_NAME, BAD_PROJECT_NAME]);
		} catch (e) {
			error = e;
		}
		expect(error).to.not.equal(undefined);
		expect(error.message).to.equal(
			"Unable to install project dependencies: custom function projects 'bad project' does not exist."
		);
		expect(path_exists_stub.callCount).to.equal(3);
		expect(path_exists_stub.firstCall.args).to.eql([COOL_PROJECT_PATH]);
		expect(path_exists_stub.secondCall.args).to.eql([COOL_PACKAGE_JSON_PATH]);
		expect(path_exists_stub.thirdCall.args).to.eql([BAD_PROJECT_PATH]);

		expect(path_join_spy.callCount).to.equal(3);
		expect(path_join_spy.firstCall.args).to.eql([`${MOCK_CF_DIR_PATH}`, COOL_PROJECT_NAME]);
		expect(path_join_spy.secondCall.args).to.eql([COOL_PROJECT_PATH, PACKAGE_JSON]);
		expect(path_join_spy.thirdCall.args).to.eql([`${MOCK_CF_DIR_PATH}`, BAD_PROJECT_NAME]);

		path_exists_restore();
		cf_routes_dir_restore();
	});

	it('test one non-existing package.json', async () => {
		let path_exists_stub = sandbox.stub();

		path_exists_stub.onCall(0).callsFake(async (path) => {
			return true;
		});
		path_exists_stub.onCall(1).callsFake(async (path) => {
			return true;
		});
		path_exists_stub.onCall(2).callsFake(async (path) => {
			return true;
		});
		path_exists_stub.onCall(3).callsFake(async (path) => {
			return false;
		});

		let cf_routes_dir_restore = npm_utils.__set__('CF_ROUTES_DIR', MOCK_CF_DIR_PATH);
		let path_exists_restore = npm_utils.__set__('fs', { pathExists: path_exists_stub });
		let path_join_spy = sandbox.spy(npm_utils.__get__('path'), 'join');

		let error;
		try {
			await check_project_paths([COOL_PROJECT_NAME, BAD_PROJECT_NAME]);
		} catch (e) {
			error = e;
		}
		expect(error).to.not.equal(undefined);
		expect(error.message).to.equal(
			"Unable to install project dependencies: custom function projects 'bad project' do not have a package.json file."
		);
		expect(path_exists_stub.callCount).to.equal(4);
		expect(path_exists_stub.getCall(0).args).to.eql([COOL_PROJECT_PATH]);
		expect(path_exists_stub.getCall(1).args).to.eql([COOL_PACKAGE_JSON_PATH]);
		expect(path_exists_stub.getCall(2).args).to.eql([BAD_PROJECT_PATH]);
		expect(path_exists_stub.getCall(3).args).to.eql([BAD_PACKAGE_JSON_PATH]);

		expect(path_join_spy.callCount).to.equal(4);
		expect(path_join_spy.getCall(0).args).to.eql([MOCK_CF_DIR_PATH, COOL_PROJECT_NAME]);
		expect(path_join_spy.getCall(1).args).to.eql([COOL_PROJECT_PATH, PACKAGE_JSON]);
		expect(path_join_spy.getCall(2).args).to.eql([MOCK_CF_DIR_PATH, BAD_PROJECT_NAME]);
		expect(path_join_spy.getCall(3).args).to.eql([BAD_PROJECT_PATH, PACKAGE_JSON]);

		path_exists_restore();
		cf_routes_dir_restore();
	});
});
if (process.env.FULL_TEST) {
	// too slow to run each time
	describe('test installModules function', () => {
		const sandbox = sinon.createSandbox();
		const install_modules = npm_utils.__get__('installModules');

		beforeEach(async () => {
			await fs.remove(MOCK_CF_DIR_PATH);
			await fs.mkdirp(COOL_PROJECT_PATH);
			await fs.mkdirp(BAD_PROJECT_PATH);

			await fs.writeJson(COOL_PACKAGE_JSON_PATH, COOL_PROJECT_PACKAGE_JSON);
			await fs.writeJson(BAD_PACKAGE_JSON_PATH, BAD_PROJECT_PACKAGE_JSON);
		});

		after(async () => {});

		afterEach(async () => {
			sandbox.restore();
			await fs.remove(MOCK_CF_DIR_PATH);
		});

		it('test mock happy path, no dry run', async () => {
			let cf_routes_dir_restore = npm_utils.__set__('CF_ROUTES_DIR', MOCK_CF_DIR_PATH);
			let path_join_spy = sandbox.spy(npm_utils.__get__('path'), 'join');
			let run_command_stub = sandbox.stub();
			run_command_stub.onCall(0).callsFake(async () => {
				return { stdout: '{ "success": true }' };
			});

			run_command_stub.onCall(1).callsFake(async () => {
				throw new Error('npm bad stuff');
			});

			let check_npm_installed_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
				return true;
			});

			let check_project_paths_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
				return;
			});

			let run_command_restore = npm_utils.__set__('p_exec', run_command_stub);
			let check_npm_installed_restore = npm_utils.__set__('checkNPMInstalled', check_npm_installed_stub);
			let check_project_paths_restore = npm_utils.__set__('checkProjectPaths', check_project_paths_stub);

			let error;
			let result;
			try {
				result = await install_modules({ projects: [COOL_PROJECT_NAME, BAD_PROJECT_NAME] });
			} catch (e) {
				error = e;
			}

			expect(error).is.equal(undefined);
			expect(result).to.eql({
				'bad project': { npm_error: 'npm bad stuff', npm_output: null },
				'cool project': {
					npm_error: null,
					npm_output: {
						success: true,
					},
				},
			});

			expect(path_join_spy.callCount).is.equal(2);
			expect(path_join_spy.firstCall.args).to.eql([MOCK_CF_DIR_PATH, COOL_PROJECT_NAME]);
			expect(path_join_spy.secondCall.args).to.eql([MOCK_CF_DIR_PATH, BAD_PROJECT_NAME]);

			expect(run_command_stub.callCount).is.equal(2);
			expect(await run_command_stub.firstCall.returnValue).is.eql({ stdout: '{ "success": true }' });
			let err;
			try {
				await run_command_stub.secondCall.returnValue;
			} catch (e) {
				err = e;
			}
			expect(err.message).is.equal('npm bad stuff');

			expect(run_command_stub.firstCall.args).to.eql(['npm install --omit=dev --json', { cwd: COOL_PROJECT_PATH }]);
			expect(run_command_stub.secondCall.args).to.eql(['npm install --omit=dev --json', { cwd: BAD_PROJECT_PATH }]);

			check_npm_installed_restore();
			check_project_paths_restore();
			cf_routes_dir_restore();
			run_command_restore();
		});

		it('test real happy path, no dry run', async () => {
			let cf_routes_dir_restore = npm_utils.__set__('CF_ROUTES_DIR', MOCK_CF_DIR_PATH);
			let path_join_spy = sandbox.spy(npm_utils.__get__('path'), 'join');
			let run_command_spy = sandbox.spy(npm_utils.__get__('p_exec'));

			let check_npm_installed_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
				return true;
			});

			let check_project_paths_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
				return;
			});

			let check_npm_installed_restore = npm_utils.__set__('checkNPMInstalled', check_npm_installed_stub);
			let check_project_paths_restore = npm_utils.__set__('checkProjectPaths', check_project_paths_stub);

			let error;
			let result;
			try {
				result = await install_modules({ projects: [COOL_PROJECT_NAME, BAD_PROJECT_NAME] });
			} catch (e) {
				error = e;
			}
			expect(error).is.equal(undefined);
			// if you are getting an error here on Windows due to a warning about --local --global flags,
			// you may need to run this:
			// https://www.npmjs.com/package/npm-windows-upgrade
			expect(result['cool project'].npm_output).is.not.equal(null);
			expect(result['bad project'].npm_output).is.equal(null);
			expect(result['bad project'].npm_error).is.not.equal(null);

			//tes cool project dayjs exists
			let access_err;
			let dayjs_path = path.join(COOL_PROJECT_PATH, 'node_modules', 'dayjs');
			try {
				await fs.access(dayjs_path);
			} catch (e) {
				access_err = e;
			}
			expect(access_err).is.equal(undefined);

			//test bad project node_modules does not exist
			let node_modules_path = path.join(BAD_PROJECT_PATH, 'node_modules');
			try {
				await fs.access(node_modules_path);
			} catch (e) {
				access_err = e;
			}
			expect(access_err).is.not.equal(undefined);

			check_npm_installed_restore();
			check_project_paths_restore();
			cf_routes_dir_restore();
		}).timeout(60000);

		it('test mock happy path, with dry run', async () => {
			let cf_routes_dir_restore = npm_utils.__set__('CF_ROUTES_DIR', MOCK_CF_DIR_PATH);
			let path_join_spy = sandbox.spy(npm_utils.__get__('path'), 'join');
			let run_command_stub = sandbox.stub();
			run_command_stub.onCall(0).callsFake(async () => {
				return { stdout: '{ "success": true }' };
			});

			run_command_stub.onCall(1).callsFake(async () => {
				throw new Error('npm bad stuff');
			});

			let check_npm_installed_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
				return true;
			});

			let check_project_paths_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
				return;
			});

			let run_command_restore = npm_utils.__set__('p_exec', run_command_stub);
			let check_npm_installed_restore = npm_utils.__set__('checkNPMInstalled', check_npm_installed_stub);
			let check_project_paths_restore = npm_utils.__set__('checkProjectPaths', check_project_paths_stub);

			let error;
			let result;
			try {
				result = await install_modules({ projects: ['cool project', 'bad project'], dry_run: true });
			} catch (e) {
				error = e;
			}

			expect(error).is.equal(undefined);
			expect(result).to.eql({
				'cool project': { npm_output: { success: true }, npm_error: null },
				'bad project': { npm_output: null, npm_error: 'npm bad stuff' },
			});

			expect(path_join_spy.callCount).is.equal(2);
			expect(path_join_spy.firstCall.args).to.eql([MOCK_CF_DIR_PATH, 'cool project']);
			expect(path_join_spy.secondCall.args).to.eql([MOCK_CF_DIR_PATH, 'bad project']);

			expect(run_command_stub.callCount).is.equal(2);
			expect(await run_command_stub.firstCall.returnValue).is.eql({ stdout: '{ "success": true }' });
			let err;
			try {
				await run_command_stub.secondCall.returnValue;
			} catch (e) {
				err = e;
			}
			expect(err.message).is.equal('npm bad stuff');

			expect(run_command_stub.firstCall.args).to.eql([
				'npm install --omit=dev --json --dry-run',
				{ cwd: COOL_PROJECT_PATH },
			]);
			expect(run_command_stub.secondCall.args).to.eql([
				'npm install --omit=dev --json --dry-run',
				{ cwd: BAD_PROJECT_PATH },
			]);

			check_npm_installed_restore();
			check_project_paths_restore();
			cf_routes_dir_restore();
			run_command_restore();
		}).timeout(20000);

		it('test real happy path, with dry run', async () => {
			let cf_routes_dir_restore = npm_utils.__set__('CF_ROUTES_DIR', MOCK_CF_DIR_PATH);
			let path_join_spy = sandbox.spy(npm_utils.__get__('path'), 'join');
			let run_command_spy = sandbox.spy(npm_utils.__get__('p_exec'));

			let check_npm_installed_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
				return true;
			});

			let check_project_paths_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
				return;
			});

			let check_npm_installed_restore = npm_utils.__set__('checkNPMInstalled', check_npm_installed_stub);
			let check_project_paths_restore = npm_utils.__set__('checkProjectPaths', check_project_paths_stub);

			let error;
			let result;
			try {
				result = await install_modules({ projects: [COOL_PROJECT_NAME, BAD_PROJECT_NAME], dry_run: true });
			} catch (e) {
				error = e;
			}
			expect(error).is.equal(undefined);
			expect(result['cool project'].npm_output).is.not.equal(null);
			expect(result['bad project'].npm_output).is.equal(null);
			expect(result['bad project'].npm_error).is.not.equal(null);

			//tes cool project dayjs does not exists
			let access_err;
			let dayjs_path = path.join(COOL_PROJECT_PATH, 'node_modules', 'dayjs');
			try {
				await fs.access(dayjs_path);
			} catch (e) {
				access_err = e;
			}
			expect(access_err).is.not.equal(undefined);

			//test bad project node_modules does not exist
			let node_modules_path = path.join(BAD_PROJECT_PATH, 'node_modules');
			try {
				await fs.access(node_modules_path);
			} catch (e) {
				access_err = e;
			}
			expect(access_err).is.not.equal(undefined);

			check_npm_installed_restore();
			check_project_paths_restore();
			cf_routes_dir_restore();
		}).timeout(20000);
	});
}
describe('test modulesValidator', () => {
	const sandbox = sinon.createSandbox();
	const validator = npm_utils.__get__('modulesValidator');

	after(() => {
		sandbox.restore();
	});

	it('test function', () => {
		let result = validator({});
		expect(result.message).is.equal("'projects' is required");

		result = validator({ projects: 'cool' });
		expect(result.message).is.equal("'projects' must be an array");

		result = validator({ projects: [] });
		expect(result.message).is.equal("'projects' must contain at least 1 items");

		result = validator({ projects: ['cool', 3] });
		expect(result.message).is.equal("'projects[1]' must be a string");

		result = validator({ projects: ['cool', 'cooler'], dry_run: 3 });
		expect(result.message).is.equal("'dry_run' must be a boolean");

		result = validator({ projects: ['cool', 'cooler'], dry_run: true });
		expect(result).is.equal(undefined);
	});
});

if (process.env.FULL_TEST) {
	describe('test auditModules', () => {
		const sandbox = sinon.createSandbox();
		const install_modules = npm_utils.__get__('installModules');
		const audit_modules = npm_utils.__get__('auditModules');

		beforeEach(async () => {
			await fs.remove(MOCK_CF_DIR_PATH);
			await fs.mkdirp(COOL_PROJECT_PATH);
			await fs.mkdirp(BAD_PROJECT_PATH);

			await fs.writeJson(COOL_PACKAGE_JSON_PATH, COOL_PROJECT_PACKAGE_JSON);
			await fs.writeJson(BAD_PACKAGE_JSON_PATH, BAD_PROJECT_PACKAGE_JSON);
		});

		after(async () => {});

		afterEach(async () => {
			sandbox.restore();
			await fs.remove(MOCK_CF_DIR_PATH);
		});

		it('test real happy path', async () => {
			let cf_routes_dir_restore = npm_utils.__set__('CF_ROUTES_DIR', MOCK_CF_DIR_PATH);

			await install_modules({ projects: [COOL_PROJECT_NAME, BAD_PROJECT_NAME] });

			let check_npm_installed_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
				return true;
			});

			let check_project_paths_stub = sandbox.stub().callsFake(async (cmd, cwd) => {
				return;
			});

			let check_npm_installed_restore = npm_utils.__set__('checkNPMInstalled', check_npm_installed_stub);
			let check_project_paths_restore = npm_utils.__set__('checkProjectPaths', check_project_paths_stub);

			let error;
			let result;
			try {
				result = await audit_modules({ projects: [COOL_PROJECT_NAME, BAD_PROJECT_NAME] });
			} catch (e) {
				error = e;
			}

			expect(error).is.equal(undefined);
			expect(result['cool project'].npm_error).is.equal(null);
			expect(result['cool project'].npm_output).is.not.equal(null);
			expect(result['bad project'].npm_output).is.equal(null);
			expect(result['bad project'].npm_error).is.not.equal(null);

			check_npm_installed_restore();
			check_project_paths_restore();
			cf_routes_dir_restore();
		}).timeout(60000);
	});
}
describe('Test install all, uninstall and link functions', () => {
	const sandbox = sinon.createSandbox();
	const run_command_stub = sandbox.stub();

	before(() => {
		env_mgr.setProperty('rootPath', 'unit/test');
		npm_utils.__set__('runCommand', run_command_stub);
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	it('Test installAllRootModules happy path', async () => {
		await npm_utils.installAllRootModules();
		expect(run_command_stub.args[1][0]).to.eql('npm install');
		expect(run_command_stub.args[1][1]).to.eql('unit/test');
	});

	it('Test uninstallRootModule happy path', async () => {
		await npm_utils.uninstallRootModule('test-me');
		expect(run_command_stub.args[0]).to.eql(['npm uninstall test-me', 'unit/test']);
	});

	it('Test linkHarperdb happy path', async () => {
		await npm_utils.linkHarperdb();
		expect(run_command_stub.args[1][0]).to.include('npm link');
		expect(run_command_stub.args[1][1]).to.eql('unit/test');
	});
});
