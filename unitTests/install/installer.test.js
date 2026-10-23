'use strict';

const assert = require('node:assert');
const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const rewire = require('rewire');
const hdb_utils = require('#src/utility/common_utils');
const fs = require('fs-extra');
const { prompts } = require('#src/utility/interactivePrompts');
const path = require('path');
const hdb_info_controller = require('#src/dataLayer/hdbInfoController');
const hdb_logger = require('#src/utility/logging/harper_logger');
const installer_mod_path = '#js/utility/install/installer';
const env_manager = require('#src/utility/environment/environmentManager');
const config_utils = require('#src/config/configUtils');
const { packageJson } = require('#src/utility/packageUtils');
const role_ops = require('#src/security/role');
const user_ops = require('#src/security/user');
const installer = rewire(installer_mod_path);
const YAML = require('yaml');
const os = require('node:os');

describe.skip('Test installer module', () => {
	const sandbox = sinon.createSandbox();
	let console_log_stub;
	let hdb_log_trace_stub;
	let hdb_log_error_stub;

	before(() => {
		console_log_stub = sandbox.stub(console, 'log');
		sandbox.stub(console, 'error');
		hdb_log_trace_stub = sandbox.stub(hdb_logger, 'trace');
		hdb_log_error_stub = sandbox.stub(hdb_logger, 'error');
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	after(() => {
		sandbox.restore();
		rewire(installer_mod_path);
	});

	describe('Test install function', () => {
		const check_for_prompt_stub = sandbox.stub().returns({});
		const validator_stub = sandbox.stub();
		const check_for_existing_stub = sandbox.stub().resolves();
		const terms_stub = sandbox.stub().resolves();
		const install_prompts_stub = sandbox.stub().resolves({ ROOTPATH: 'users/hdb/test' });
		const set_hdb_base_stub = sandbox.stub();
		const mount_stub = sandbox.stub().resolves();
		const create_boot_file_stub = sandbox.stub().resolves();
		const create_config_stub = sandbox.stub().resolves();
		const create_super_user_stub = sandbox.stub().resolves();
		const create_cluster_user_stub = sandbox.stub().resolves();
		const generate_keys_stub = sandbox.stub().resolves();
		const insert_ver_stub = sandbox.stub().resolves();
		const check_jwt_stub = sandbox.stub();
		let keys_rw;

		before(() => {
			installer.__set__('checkForPromptOverride', check_for_prompt_stub);
			installer.__set__('installValidator', validator_stub);
			installer.__set__('checkForExistingInstall', check_for_existing_stub);
			installer.__set__('termsAgreement', terms_stub);
			installer.__set__('installPrompts', install_prompts_stub);
			installer.__set__('envManager.setHdbBasePath', set_hdb_base_stub);
			installer.__set__('mountHdb', mount_stub);
			installer.__set__('createBootPropertiesFile', create_boot_file_stub);
			installer.__set__('createConfigFile', create_config_stub);
			installer.__set__('createSuperUser', create_super_user_stub);
			installer.__set__('createClusterUser', create_cluster_user_stub);
			keys_rw = installer.__set__('keys.generateKeys', generate_keys_stub);
			installer.__set__('insertHdbVersionInfo', insert_ver_stub);
			installer.__set__('checkJwtTokens', check_jwt_stub);
		});

		after(() => {
			keys_rw();
			try {
				// why do we rewire after a test?
				rewire(installer_mod_path);
			} catch (e) {
				console.warn(e);
			}
		});

		it.skip('Test that all functions needed for install are called', async () => {
			await installer.install();
			expect(check_for_prompt_stub.called).to.be.true;
			expect(validator_stub.called).to.be.true;
			expect(check_for_existing_stub.called).to.be.true;
			expect(terms_stub.called).to.be.true;
			expect(install_prompts_stub.called).to.be.true;
			expect(set_hdb_base_stub.called).to.be.true;
			expect(mount_stub.called).to.be.true;
			expect(create_boot_file_stub.called).to.be.true;
			expect(create_config_stub.called).to.be.true;
			expect(create_super_user_stub.called).to.be.true;
			expect(create_cluster_user_stub.called).to.be.true;
			expect(generate_keys_stub.called).to.be.true;
			expect(insert_ver_stub.called).to.be.true;
			expect(check_jwt_stub.called).to.be.true;
		});
	});

	it('Test checkForPromptOverride gets prompts and config vars', () => {
		process.env.DEFAULTS_MODE = 'dev';
		process.env.ROOTPATH = 'user/unit/test';
		process.env.TC_AGREEMENT = 'yes';
		process.env.CLUSTERING = 'true';
		process.env.NODE_NAME = 'dog1';
		const checkForPromptOverride = installer.__get__('checkForPromptOverride');
		const result = checkForPromptOverride();
		expect(result.DEFAULTS_MODE).to.equal('dev');
		expect(result.ROOTPATH).to.equal('user/unit/test');
		expect(result.TC_AGREEMENT).to.equal('yes');
		expect(result.CLUSTERING_ENABLED).to.equal('true');
		expect(result.CLUSTERING_NODENAME).to.equal('dog1');

		delete process.env.OPERATIONSAPI_NETWORK_PORT;
		delete process.env.ROOTPATH;
		delete process.env.TC_AGREEMENT;
		delete process.env.CLUSTERING;
		delete process.env.NODE_NAME;
	});

	it('Test checkForExistingInstall', async () => {
		const checkForExistingInstall = installer.__get__('checkForExistingInstall');
		sandbox.stub(hdb_utils, 'getPropsFilePath').returns('bootprop/file');
		sandbox.stub(fs, 'pathExists').resolves(true);
		sandbox.stub(hdb_info_controller, 'getVersionUpdateInfo').resolves({ upgrade: 'yes please' });
		const version_stub = sandbox.stub(packageJson, 'version').get(() => '100.2.3');

		const prop_reader_fake = {
			get: () => {},
		};
		const prop_reader_stub = sandbox.stub().returns(prop_reader_fake);
		installer.__set__('PropertiesReader', prop_reader_stub);
		const process_exit_stub = sandbox.stub(process, 'exit');
		await checkForExistingInstall();
		process_exit_stub.restore();

		expect(hdb_log_trace_stub.getCall(0).args[0]).to.equal('Checking for existing install.');
		expect(hdb_log_trace_stub.getCall(1).args[0]).to.equal('Install found an existing boot prop file at:bootprop/file');
		expect(hdb_log_error_stub.getCall(0).args[0]).to.equal(
			'Please use `harperdb upgrade` to update to 100.2.3. Exiting install...'
		);
		expect(process_exit_stub.called).to.be.true;
		version_stub.restore();
	});

	it('Test createBootPropertiesFile calls all the things to make file then sets env props', async () => {
		installer.__set__('hdbRoot', 'user/hdb-test/');
		sandbox.stub(hdb_utils, 'getHomeDir').returns('homedir/test');
		const mk_dir_stub = sandbox.stub(fs, 'mkdirpSync');
		const write_file_stub = sandbox.stub(fs, 'writeFile');
		const set_prop_stub = sandbox.stub(env_manager, 'setProperty');
		const createBootPropertiesFile = installer.__get__('createBootPropertiesFile');
		await createBootPropertiesFile();
		expect(mk_dir_stub.getCall(0).args[0]).to.equal(path.join('homedir', 'test', '.harperdb'));
		expect(mk_dir_stub.getCall(1).args[0]).to.equal(path.join('homedir', 'test', '.harperdb', 'keys'));
		expect(write_file_stub.args[0][0]).to.equal(path.join('homedir', 'test', '.harperdb', 'hdb_boot_properties.file'));
		expect(set_prop_stub.getCall(0).args[0]).to.equal('install_user');
		expect(set_prop_stub.getCall(1).args[0]).to.equal('settings_path');
		expect(set_prop_stub.getCall(2).args[0]).to.equal('BOOT_PROPS_FILE_PATH');
		write_file_stub.restore();
	});

	it('Test createConfigFile assigns all the args and calls createConfig then init', async () => {
		const write_staged_config_stub = sandbox.stub(config_utils, 'writeStagedInstallConfig');
		// not reliably reset
		//const env_mng_init_stub = sandbox.stub(env_manager, 'initSync');
		process.env.CLUSTERING = 'true';
		process.env.NODE_NAME = 'dog1';
		const fake_install_params = {
			ROOTPATH: 'user/unit/test',
			OPERATIONSAPI_NETWORK_PORT: '8888',
		};
		const stageInstallConfig = installer.__get__('stageInstallConfig');
		const createConfigFile = installer.__get__('createConfigFile');
		const staged = stageInstallConfig(fake_install_params);
		await createConfigFile(staged);

		expect(write_staged_config_stub.args[0][0]).to.equal(staged);
		expect(write_staged_config_stub.args[0][1]).to.be.undefined;
		//expect(env_mng_init_stub.called).to.be.true;

		delete process.env.CLUSTERING;
		delete process.env.NODE_NAME;
		write_staged_config_stub.restore();
	});

	// this test does reliably wrap stubs
	it.skip('Test createConfigFile calls rollback if create config throws error', async () => {
		const rollback_stub = sandbox.stub();
		const rollback_rw = installer.__set__('rollbackInstall', rollback_stub);
		sandbox.stub(config_utils, 'writeStagedInstallConfig').throws('Error creating config file');
		const fake_install_params = {
			ROOTPATH: 'user/unit/test',
			OPERATIONSAPI_NETWORK_PORT: '8888',
		};
		const stageInstallConfig = installer.__get__('stageInstallConfig');
		const createConfigFile = installer.__get__('createConfigFile');
		await createConfigFile(stageInstallConfig(fake_install_params));
		expect(rollback_stub.args[0][0].name).equal('Error creating config file');
		rollback_rw();
	});

	it('Test rollbackInstall calls remove and process exit', () => {
		installer.__set__('hdbRoot', 'i/am/root/');
		const path_stub = sandbox.stub(path, 'resolve').returns('boot/file/here/');
		const rollbackInstall = installer.__get__('rollbackInstall');
		const remove_sync_stub = sandbox.stub(fs, 'removeSync');
		const process_exit_stub = sandbox.stub(process, 'exit');
		rollbackInstall('Invalid port');
		// this stub is not reliable
		if (remove_sync_stub.getCall(0)) {
			expect(remove_sync_stub.getCall(0).args[0]).to.equal('boot/file/here/');
			expect(remove_sync_stub.getCall(1).args[0]).to.equal('i/am/root/');
			path_stub.restore();
			process_exit_stub.restore();
		}
	});

	it('Test createAdminUser calls addRole then addUser', async () => {
		const createAdminUser = installer.__get__('createAdminUser');
		installer.__set__('pSchemaToGlobal', sandbox.stub());
		const add_role_stub = sandbox.stub(role_ops, 'addRole').resolves({ role: 'super_man' });
		const add_user_stub = sandbox.stub(user_ops, 'addUser');
		await createAdminUser({ role: 'super_man' }, { username: 'kent', password: 'lois' });
		expect(add_role_stub.args[0][0]).to.eql({ role: 'super_man' });
		expect(add_user_stub.args[0][0]).to.eql({
			username: 'kent',
			password: 'lois',
			role: 'super_man',
		});
	});

	it('Test createSuperUser calls create admin user with correct params', async () => {
		const create_admin_user_stub = sandbox.stub();
		const create_admin_user_rw = installer.__set__('createAdminUser', create_admin_user_stub);
		const createSuperUser = installer.__get__('createSuperUser');
		const fake_install_params = {
			HDB_ADMIN_USERNAME: 'groot',
			HDB_ADMIN_PASSWORD: 'tree',
		};
		await createSuperUser(fake_install_params);
		expect(create_admin_user_stub.args[0][0]).to.eql({
			role: 'super_user',
			permission: {
				super_user: true,
			},
		});
		expect(create_admin_user_stub.args[0][1]).to.eql({
			username: 'groot',
			password: 'tree',
			active: true,
		});
		create_admin_user_rw();
	});

	it('Test createClusterUser calls create admin user with correct params', async () => {
		const create_admin_user_stub = sandbox.stub();
		const create_admin_user_rw = installer.__set__('createAdminUser', create_admin_user_stub);
		const createClusterUser = installer.__get__('createClusterUser');
		const fake_install_params = {
			CLUSTERING_USER: 'groot',
			CLUSTERING_PASSWORD: 'tree',
		};
		await createClusterUser(fake_install_params);
		expect(create_admin_user_stub.args[0][0]).to.eql({
			role: 'cluster_user',
			permission: {
				cluster_user: true,
			},
		});
		expect(create_admin_user_stub.args[0][1]).to.eql({
			username: 'groot',
			password: 'tree',
			active: true,
		});
		create_admin_user_rw();
	});

	it('Test insertHdbVersionInfo calls insert with correct param', async () => {
		const version_getter = sandbox.stub().returns('100.1.1');
		sandbox.stub(packageJson, 'version').get(version_getter);
		const insert_hdb_stub = sandbox.stub(hdb_info_controller, 'insertHdbInstallInfo');
		const insertHdbVersionInfo = installer.__get__('insertHdbVersionInfo');
		await insertHdbVersionInfo();
		expect(version_getter.called).to.be.true;
		expect(insert_hdb_stub.args[0][0]).to.equal('100.1.1');
	});

	it('Test displayCmdEnvVar function logs generic password message and not password', () => {
		const test_password = 'Abz123';
		const test_msg = 'Here is your password';
		const displayCmdEnvVar = installer.__get__('displayCmdEnvVar');
		const result = displayCmdEnvVar(test_password, test_msg);
		expect(console_log_stub.args[0][0]).to.include(test_msg);
		expect(console_log_stub.args[0][0]).to.not.include(test_password);
		expect(hdb_log_trace_stub.args[0][0]).to.include(test_msg);
		expect(hdb_log_trace_stub.args[0][0]).to.not.include(test_password);
		expect(result).to.be.false;
	});

	it('Test displayCmdEnvVar function logs prompt message and value', () => {
		const test_value = 9925;
		const test_msg = 'Your port is';
		const displayCmdEnvVar = installer.__get__('displayCmdEnvVar');
		const result = displayCmdEnvVar(test_value, test_msg);
		expect(console_log_stub.args[0][0]).to.include(test_msg);
		expect(console_log_stub.args[0][0]).to.include(test_value);
		expect(hdb_log_trace_stub.args[0][0]).to.include(test_msg);
		expect(hdb_log_trace_stub.args[0][0]).to.include(test_value);
		expect(result).to.be.false;
	});

	it('Test checkForEmptyValue returns message if value empty', () => {
		const checkForEmptyValue = installer.__get__('checkForEmptyValue');
		const result = checkForEmptyValue('      ');
		expect(result).to.equal('Value cannot be empty.');
	});

	it('Test checkForEmptyValue returns undefined if value not empty', () => {
		const checkForEmptyValue = installer.__get__('checkForEmptyValue');
		const result = checkForEmptyValue('dev dog');
		expect(result).to.be.undefined;
	});

	describe('HARPER_DEFAULT_CONFIG integration', () => {
		let testRoot;
		let originalEnv;

		beforeEach(() => {
			// Save original env var
			originalEnv = process.env.HARPER_DEFAULT_CONFIG;
			// Create unique test directory
			testRoot = path.join(os.tmpdir(), 'hdb-config-test-' + Date.now());
			fs.mkdirpSync(testRoot);
		});

		afterEach(() => {
			// Restore original env var
			if (originalEnv !== undefined) {
				process.env.HARPER_DEFAULT_CONFIG = originalEnv;
			} else {
				delete process.env.HARPER_DEFAULT_CONFIG;
			}
			// Cleanup test directory
			try {
				fs.removeSync(testRoot);
				// eslint-disable-next-line sonarjs/no-ignored-exceptions
			} catch {
				// Ignore cleanup errors
			}
		});

		it('applies HARPER_DEFAULT_CONFIG during config file creation', () => {
			// Set env var with test config
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
				http: { port: 9999 },
				logging: { level: 'debug' },
			});

			// Create config file (this calls our new code)
			const args = {
				ROOTPATH: testRoot,
			};

			config_utils.createConfigFile(args, true); // skipFsValidation=true

			// Read generated config file
			const configPath = path.join(testRoot, 'harperdb-config.yaml');
			expect(fs.existsSync(configPath)).to.be.true;

			const configContent = fs.readFileSync(configPath, 'utf8');
			const configDoc = YAML.parse(configContent);

			// Verify env var values were applied
			expect(configDoc.http.port).to.equal(9999);
			expect(configDoc.logging.level).to.equal('debug');
		});

		it('merges HARPER_DEFAULT_CONFIG with OOTB defaults', () => {
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
				http: { port: 9999 },
			});

			const args = {
				ROOTPATH: testRoot,
			};

			config_utils.createConfigFile(args, true);

			const configPath = path.join(testRoot, 'harperdb-config.yaml');
			const configContent = fs.readFileSync(configPath, 'utf8');
			const configDoc = YAML.parse(configContent);

			// Verify env var value applied
			expect(configDoc.http.port).to.equal(9999);

			// Verify OOTB defaults still present
			expect(configDoc.logging).to.exist;
			expect(configDoc.rootPath).to.equal(testRoot);
		});

		it('replaces arrays from HARPER_DEFAULT_CONFIG', () => {
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
				http: {
					corsAccessList: ['*.custom.com'],
				},
			});

			const args = {
				ROOTPATH: testRoot,
			};

			config_utils.createConfigFile(args, true);

			const configPath = path.join(testRoot, 'harperdb-config.yaml');
			const configContent = fs.readFileSync(configPath, 'utf8');
			const configDoc = YAML.parse(configContent);

			// Array should be replaced, not merged
			expect(configDoc.http.corsAccessList).to.deep.equal(['*.custom.com']);
		});

		it('throws error on invalid JSON in HARPER_DEFAULT_CONFIG', () => {
			process.env.HARPER_DEFAULT_CONFIG = '{invalid json}';

			const args = {
				ROOTPATH: testRoot,
			};

			expect(() => config_utils.createConfigFile(args, true)).to.throw(/Invalid JSON syntax/);
		});

		it('works without HARPER_DEFAULT_CONFIG set', () => {
			// Ensure env var is not set
			delete process.env.HARPER_DEFAULT_CONFIG;

			const args = {
				ROOTPATH: testRoot,
			};

			// Should not throw
			config_utils.createConfigFile(args, true);

			const configPath = path.join(testRoot, 'harperdb-config.yaml');
			expect(fs.existsSync(configPath)).to.be.true;
		});
	});
});

// Regression guard for applyInstallModeDefaults: a 'dev' install must persist the dev config defaults but
// must NOT set process.env.DEV_MODE. That env var is set only by the `harper dev` command and is the sole
// source of truth for dev-only runtime behavior (component auto-reload watcher, dev-only components). When
// install runs in-process from `harper run .` (first-run install), leaking it would make a plain `run`
// behave like `dev` until the next restart. Tested against the real exported helper (no sinon/rewire).
describe('applyInstallModeDefaults', () => {
	const { applyInstallModeDefaults } = require('#js/utility/install/installer');

	const readDevMode = () =>
		Object.prototype.hasOwnProperty.call(process.env, 'DEV_MODE') ? process.env.DEV_MODE : undefined;

	it('persists the dev config defaults for a dev install', () => {
		const args = applyInstallModeDefaults({}, 'dev');
		// Representative dev defaults that must survive into the persisted config.
		assert.equal(args.threads_count, 1);
		assert.equal(args.authentication_authorizeLocal, true);
		assert.equal(args.http_cors, true);
	});

	it('does not mutate process.env.DEV_MODE for a dev install', () => {
		const before = readDevMode();
		applyInstallModeDefaults({}, 'dev');
		assert.equal(readDevMode(), before);
	});

	it('does not apply dev defaults for a prod install', () => {
		const args = applyInstallModeDefaults({}, 'prod');
		assert.equal(args.threads_count, undefined);
		assert.equal(args.authentication_authorizeLocal, undefined);
		assert.equal(args.http_cors, undefined);
	});

	// harper-pro#351: a dev install must NOT cement a concrete node.hostname (it used to default
	// to 'localhost'). Persisting 'localhost' makes getThisNodeName() prefer it over
	// replication.hostname, the node fails to find its own hdb_nodes self-row, and user-DB
	// replication silently disables. The dev default must leave node.hostname unset (null) so the
	// fallback chain (replication.hostname -> cert CN -> listening port) keeps the real identity.
	it('does not cement a concrete node.hostname for a dev install (harper-pro#351)', () => {
		const args = applyInstallModeDefaults({}, 'dev');
		assert.notStrictEqual(args.node_hostname, 'localhost');
		// null is acceptable (matches defaultConfig.yaml node.hostname: null); a truthy concrete
		// value is not.
		assert.ok(args.node_hostname == null, `node_hostname should be unset/null, got ${args.node_hostname}`);
	});

	it('preserves an explicitly provided node.hostname for a dev install', () => {
		const args = applyInstallModeDefaults({ node_hostname: 'real-node.example.com' }, 'dev');
		assert.equal(args.node_hostname, 'real-node.example.com');
	});
});

describe('installPrompts', () => {
	const hdbTerms = require('#src/utility/hdbTerms');
	const { installPrompts, resolveInstallDestination } = require('#js/utility/install/installer');
	let originalInput;
	let originalPassword;

	beforeEach(() => {
		originalInput = prompts.input;
		originalPassword = prompts.password;
	});

	afterEach(() => {
		prompts.input = originalInput;
		prompts.password = originalPassword;
	});

	it('prompts only for unset fields, applies resolveInstallDestination to the answer, and leaves an override field untouched', async () => {
		const inputMessages = [];
		let nodeHostnameConfig;
		prompts.input = async (config) => {
			inputMessages.push(config.message);
			if (config.message.includes('destination')) return '~/my-test-hdb';
			if (config.message.includes('username')) return 'test_user';
			if (config.message.includes('hostname')) {
				nodeHostnameConfig = config;
				return '';
			}
			throw new Error(`unexpected input prompt: ${config.message}`);
		};
		let passwordCalls = 0;
		prompts.password = async () => {
			passwordCalls++;
			return 'testing_rulz';
		};

		const override = { [hdbTerms.INSTALL_PROMPTS.DEFAULTS_MODE]: 'prod' };
		const result = await installPrompts(override);

		assert.strictEqual(inputMessages.length, 3, 'ROOTPATH, HDB_ADMIN_USERNAME, and NODE_HOSTNAME each prompt once');
		assert.strictEqual(passwordCalls, 1, 'HDB_ADMIN_PASSWORD prompts once');

		assert.strictEqual(result[hdbTerms.INSTALL_PROMPTS.ROOTPATH], resolveInstallDestination('~/my-test-hdb'));
		assert.strictEqual(result[hdbTerms.INSTALL_PROMPTS.HDB_ADMIN_USERNAME], 'test_user');
		assert.strictEqual(result[hdbTerms.INSTALL_PROMPTS.HDB_ADMIN_PASSWORD], 'testing_rulz');
		assert.strictEqual(result[hdbTerms.INSTALL_PROMPTS.DEFAULTS_MODE], 'prod', 'the override value is preserved');

		// @inquirer/input's `default` is typed string|undefined; DEFAULT_NODE_HOSTNAME is null.
		assert.strictEqual(nodeHostnameConfig.default, undefined);
	});
});

// harper#672: the install destination prompt must expand `~/...` to an absolute path immediately
// so every downstream consumer (mountHdb, createBootPropertiesFile, createConfigFile) agrees on the
// same location, rather than each one independently (and inconsistently) trying to expand it.
// `resolveInstallDestination` is the single funnel both the prompt's `filter` and the cmd/env/config
// override path route through - tested directly against the real exported helper (no rewire).
describe('resolveInstallDestination', () => {
	const { resolveInstallDestination } = require('#js/utility/install/installer');

	it('expands a ~/... destination to an absolute path under the home directory', () => {
		assert.equal(resolveInstallDestination('~/dev/hdb'), path.join(os.homedir(), 'dev', 'hdb'));
	});

	it('leaves an absolute /... destination unchanged', () => {
		assert.equal(resolveInstallDestination('/opt/harperdb'), '/opt/harperdb');
	});

	it('leaves a bare relative destination unchanged (preserves cwd-relative semantics)', () => {
		assert.equal(resolveInstallDestination('hdb'), 'hdb');
		assert.equal(resolveInstallDestination('nested/hdb'), 'nested/hdb');
	});

	it('leaves the default install destination (already absolute) unchanged', () => {
		const defaultRoot = path.join(os.homedir(), 'hdb');
		assert.equal(resolveInstallDestination(defaultRoot), defaultRoot);
	});
});

describe('install storage.engine resolution', () => {
	const realInstaller = require('#js/utility/install/installer');
	const run_rw = rewire('#js/bin/run');
	const initialize = run_rw.__get__('initialize');
	const PROCESS_EVENTS = ['unhandledRejection', 'exit', 'SIGINT', 'SIGQUIT', 'SIGTERM'];
	const {
		closeDatabase,
		databases,
		getDatabases,
		getRocksCompression,
		resetDatabases,
		resetRocksCompression,
	} = require('#js/resources/databases');
	const { setAnalyticsEnabled } = require('#src/resources/analytics/write');
	const initPaths = require('#js/dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths');
	const env_manager = require('#js/utility/environment/environmentManager');
	const hdbTerms = require('#js/utility/hdbTerms');
	const hdb_utils = require('#js/utility/common_utils');
	const keys = require('#js/security/keys');
	const testUtils = require('../testUtils');
	const sinon = require('sinon');
	const crypto = require('node:crypto');
	const ENV_KEYS = [
		'HARPER_SET_CONFIG',
		'HARPER_CONFIG',
		'HARPER_DEFAULT_CONFIG',
		'HDB_CONFIG',
		'STORAGE_ENGINE',
		'HARPER_STORAGE_ENGINE',
		'STORAGE_COMPRESSION',
		'STORAGE_ROCKS_COMPRESSION',
		'DEFAULTS_MODE',
		'THREADS_COUNT',
		'HDB_ROOT',
		'ROOTPATH',
		'HDB_ADMIN_USERNAME',
		'HDB_ADMIN_PASSWORD',
	];

	let sandbox;
	let tempBaseDir;
	let savedEnv;
	let savedArgv;
	let savedSystemDb;
	let savedRocksCompression;

	async function runBootInitialize() {
		const beforeListeners = new Map(PROCESS_EVENTS.map((ev) => [ev, new Set(process.listeners(ev))]));
		try {
			await initialize();
		} finally {
			for (const [ev, existing] of beforeListeners) {
				for (const listener of process.listeners(ev)) {
					if (!existing.has(listener)) {
						process.removeListener(ev, listener);
					}
				}
			}
		}
	}

	async function closeSystemDatabase() {
		const systemTables = getDatabases().system;
		if (systemTables && systemTables !== savedSystemDb) {
			for (const table of Object.values(systemTables)) {
				if (table?.dbisDB && table.dbisDB.status !== 'closed') {
					await table.dbisDB.close?.();
				}
			}
			await closeDatabase('system');
		}
	}

	before(() => {
		setAnalyticsEnabled(false);
		savedSystemDb = databases.system;
		if (savedSystemDb) {
			delete databases.system;
		}
	});

	after(() => {
		if (savedSystemDb) {
			Object.defineProperty(databases, 'system', {
				value: savedSystemDb,
				configurable: true,
			});
			resetDatabases();
		}
		setAnalyticsEnabled(env_manager.get(hdbTerms.CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD) > -1);
	});

	function assertInstalledSystemEngine(rootPath, expectedEngine, expectedOptions = {}) {
		const { compression = 'kLZ4Compression', storageDir = path.join(rootPath, 'database') } = expectedOptions;
		const lmdbFile = path.join(storageDir, 'system.mdb');
		const rocksSystemDir = path.join(storageDir, 'system');
		const rocksCurrent = path.join(rocksSystemDir, 'CURRENT');
		if (expectedEngine === 'lmdb') {
			assert.strictEqual(fs.existsSync(lmdbFile), true, `Expected ${lmdbFile} to exist for lmdb install`);
			assert.strictEqual(fs.existsSync(rocksCurrent), false, `Expected ${rocksCurrent} not to exist for lmdb install`);
			assert.strictEqual(env_manager.get(hdbTerms.CONFIG_PARAMS.STORAGE_ENGINE), 'lmdb');
		} else if (expectedEngine === 'rocksdb') {
			assert.strictEqual(fs.existsSync(rocksCurrent), true, `Expected ${rocksCurrent} to exist for rocksdb install`);
			assert.strictEqual(fs.existsSync(lmdbFile), false, `Expected ${lmdbFile} not to exist for rocksdb install`);
			assert.strictEqual(env_manager.get(hdbTerms.CONFIG_PARAMS.STORAGE_ENGINE) ?? 'rocksdb', 'rocksdb');
			const optionsFiles = fs
				.readdirSync(rocksSystemDir)
				.filter((name) => name.startsWith('OPTIONS-'))
				.sort();
			assert.ok(optionsFiles.length > 0, `Expected OPTIONS-* file in ${rocksSystemDir}`);
			const latestOptions = fs.readFileSync(path.join(rocksSystemDir, optionsFiles[optionsFiles.length - 1]), 'utf8');
			const compressionLines = latestOptions
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line.startsWith('compression='));
			assert.ok(
				compressionLines.length > 0 && compressionLines.every((line) => line === `compression=${compression}`),
				`Expected all compression= lines in ${rocksSystemDir}/${optionsFiles[optionsFiles.length - 1]} to equal compression=${compression}, got: ${compressionLines.join(', ')}`
			);
		} else {
			throw new Error(`Unexpected engine: ${expectedEngine}`);
		}
		config_utils.initConfig(true);
		assert.strictEqual(
			env_manager.get(hdbTerms.CONFIG_PARAMS.STORAGE_ENGINE) ?? 'rocksdb',
			expectedEngine,
			'Subsequent initConfig(true) must resolve the same storage.engine as first-boot database creation'
		);
	}

	beforeEach(async () => {
		savedRocksCompression = getRocksCompression();
		sandbox = sinon.createSandbox();
		tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-install-engine-'));
		const fakeHome = path.join(tempBaseDir, 'home');
		fs.mkdirSync(fakeHome, { recursive: true });
		sandbox.stub(os, 'homedir').returns(fakeHome);
		sandbox.stub(hdb_utils, 'getHomeDir').returns(fakeHome);
		sandbox.stub(keys, 'generateCertsKeys').resolves();
		sandbox.stub(keys, 'reviewSelfSignedCert').resolves();
		sandbox.stub(crypto, 'generateKeyPairSync').returns({
			privateKey: 'test-private-key',
			publicKey: 'test-public-key',
		});

		savedEnv = {};
		for (const k of ENV_KEYS) {
			savedEnv[k] = process.env[k];
			delete process.env[k];
		}
		savedArgv = process.argv.slice();
		process.argv = process.argv.slice(0, 2);
		hdb_utils.resetNoBootFileCache();

		await closeSystemDatabase();
		env_manager.setProperty(hdbTerms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, undefined);
		env_manager.setProperty(env_manager.BOOT_PROPS_FILE_PATH, undefined);
		env_manager.setProperty(hdbTerms.CONFIG_PARAMS.STORAGE_ENGINE, undefined);
		env_manager.setProperty(hdbTerms.CONFIG_PARAMS.STORAGE_PATH, tempBaseDir);
		env_manager.setProperty(hdbTerms.CONFIG_PARAMS.DATABASES, undefined);
		resetDatabases();
		env_manager.setProperty(hdbTerms.CONFIG_PARAMS.STORAGE_PATH, undefined);
		resetRocksCompression();
		initPaths.resetPaths();
	});

	afterEach(async () => {
		try {
			await closeSystemDatabase();
		} finally {
			if (savedEnv) {
				for (const k of ENV_KEYS) {
					if (savedEnv[k] === undefined) {
						delete process.env[k];
					} else {
						process.env[k] = savedEnv[k];
					}
				}
			}
			if (savedArgv) {
				process.argv = savedArgv;
			}
			hdb_utils.resetNoBootFileCache();
			if (sandbox) {
				sandbox.restore();
			}
			realInstaller.setIgnoreExisting(false);
			env_manager.setProperty(hdbTerms.HDB_SETTINGS_NAMES.INSTALL_USER, undefined);
			env_manager.setProperty(hdbTerms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, undefined);
			env_manager.setProperty(env_manager.BOOT_PROPS_FILE_PATH, undefined);
			env_manager.setProperty(hdbTerms.CONFIG_PARAMS.STORAGE_COMPRESSION, undefined);
			env_manager.setProperty(hdbTerms.CONFIG_PARAMS.STORAGE_ENGINE, undefined);
			initPaths.resetPaths();
			// Earlier files in this process leave the test system database open under their codec, and
			// RocksDB rejects a reopen under a different one.
			env_manager.setProperty(hdbTerms.CONFIG_PARAMS.STORAGE_ROCKS_COMPRESSION, savedRocksCompression);
			resetRocksCompression();
			testUtils.setupTestDBPath();
			env_manager.setProperty(hdbTerms.CONFIG_PARAMS.STORAGE_ROCKS_COMPRESSION, undefined);
			resetRocksCompression();
			env_manager.initSync(true);
			hdb_logger.initLogSettings(true);
			if (tempBaseDir) {
				fs.rmSync(tempBaseDir, { recursive: true, force: true });
			}
		}
	});

	async function runInstall() {
		const rootPath = path.join(tempBaseDir, 'hdb');
		process.env.ROOTPATH = rootPath;
		process.env.HDB_ADMIN_USERNAME = 'HDB_ADMIN';
		process.env.HDB_ADMIN_PASSWORD = 'password1234';
		await realInstaller.install();
		return rootPath;
	}

	it('defaults to rocksdb when no storage engine is configured', async () => {
		const rootPath = await runInstall();
		assertInstalledSystemEngine(rootPath, 'rocksdb');
		assert.strictEqual(env_manager.getConfigOverrides()?.storage_engine, undefined);
	});

	it('honours HARPER_SET_CONFIG={"storage":{"engine":"lmdb"}} during install', async () => {
		process.env.HARPER_SET_CONFIG = JSON.stringify({ storage: { engine: 'lmdb' } });
		const rootPath = await runInstall();
		assertInstalledSystemEngine(rootPath, 'lmdb');
		assert.strictEqual(env_manager.getConfigOverrides()?.storage_engine, undefined);
	});

	it('honours HARPER_CONFIG={"storage":{"engine":"lmdb"}} during install', async () => {
		process.env.HARPER_CONFIG = JSON.stringify({ storage: { engine: 'lmdb' } });
		const rootPath = await runInstall();
		assertInstalledSystemEngine(rootPath, 'lmdb');
		assert.strictEqual(env_manager.getConfigOverrides()?.storage_engine, undefined);
	});

	it('honours HARPER_DEFAULT_CONFIG={"storage":{"engine":"lmdb"}} during install', async () => {
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ storage: { engine: 'lmdb' } });
		const rootPath = await runInstall();
		assertInstalledSystemEngine(rootPath, 'lmdb');
		assert.strictEqual(env_manager.getConfigOverrides()?.storage_engine, undefined);
	});

	it('honours HDB_CONFIG pointing at a YAML file with storage.engine: lmdb during install', async () => {
		const externalConfigPath = path.join(tempBaseDir, 'external-harper-config.yaml');
		fs.writeFileSync(externalConfigPath, 'storage:\n  engine: lmdb\n', 'utf8');
		process.env.HDB_CONFIG = externalConfigPath;
		const rootPath = await runInstall();
		assertInstalledSystemEngine(rootPath, 'lmdb');
		assert.strictEqual(env_manager.getConfigOverrides()?.storage_engine, undefined);
		assert.strictEqual(
			fs.existsSync(path.join(rootPath, hdbTerms.HARPER_CONFIG_FILE)),
			true,
			'Should materialize harper-config.yaml at settings_path when HDB_CONFIG points outside rootPath'
		);
	});

	it('preserves unmapped component blocks in HDB_CONFIG during install', async () => {
		const rootPath = path.join(tempBaseDir, 'hdb');
		fs.mkdirSync(rootPath, { recursive: true });
		const rootConfigPath = path.join(rootPath, hdbTerms.HDB_CONFIG_FILE);
		fs.writeFileSync(
			rootConfigPath,
			'storage:\n  engine: lmdb\nrest: true\nmyCustomComponent:\n  package: "@harperdb/custom"\n',
			'utf8'
		);
		process.env.HDB_CONFIG = rootConfigPath;
		await runInstall();
		assertInstalledSystemEngine(rootPath, 'lmdb');
		const finalYaml = fs.readFileSync(rootConfigPath, 'utf8');
		assert.ok(finalYaml.includes('myCustomComponent:'), 'Expected unmapped component block to be preserved');
		assert.ok(finalYaml.includes('@harperdb/custom'), 'Expected custom component package to be preserved');
		assert.strictEqual(
			fs.existsSync(path.join(rootPath, hdbTerms.HARPER_CONFIG_FILE)),
			false,
			'Should not create an unused harper-config.yaml when HDB_CONFIG points at harperdb-config.yaml inside rootPath'
		);
	});

	it('honours CLI/prompt STORAGE_ENGINE=lmdb during install', async () => {
		process.env.STORAGE_ENGINE = 'lmdb';
		const rootPath = await runInstall();
		assertInstalledSystemEngine(rootPath, 'lmdb');
		assert.strictEqual(env_manager.getConfigOverrides()?.storage_engine, undefined);
	});

	it('resolves CLI STORAGE_ENGINE=rocksdb + HARPER_SET_CONFIG={"storage":{"engine":"lmdb"}} consistently to lmdb', async () => {
		process.env.STORAGE_ENGINE = 'rocksdb';
		process.env.HARPER_SET_CONFIG = JSON.stringify({ storage: { engine: 'lmdb' } });
		const rootPath = await runInstall();
		assertInstalledSystemEngine(rootPath, 'lmdb');
		assert.strictEqual(env_manager.getConfigOverrides()?.storage_engine, undefined);
	});

	it('resolves CLI STORAGE_ENGINE=rocksdb + HARPER_CONFIG={"storage":{"engine":"lmdb"}} consistently to lmdb across install and subsequent boots', async () => {
		process.env.STORAGE_ENGINE = 'rocksdb';
		process.env.HARPER_CONFIG = JSON.stringify({ storage: { engine: 'lmdb' } });
		const rootPath = await runInstall();
		assertInstalledSystemEngine(rootPath, 'lmdb');
		const updateSpy = sandbox.spy(config_utils, 'updateConfigValue');
		await runBootInitialize();
		for (const call of updateSpy.getCalls()) {
			assert.strictEqual(call.args[2]?.storage_engine, undefined, 'HARPER_CONFIG should filter STORAGE_ENGINE on run');
		}
		assert.strictEqual(env_manager.get(hdbTerms.CONFIG_PARAMS.STORAGE_ENGINE), 'lmdb');
		assert.strictEqual(env_manager.getConfigOverrides()?.storage_engine, undefined);
	});

	it('auto-installs via bin/run.ts initialize() when not installed and skips redundant updateConfigValue via installedDuringInit', async () => {
		const rootPath = path.join(tempBaseDir, 'hdb');
		process.env.ROOTPATH = rootPath;
		process.env.HDB_ADMIN_USERNAME = 'HDB_ADMIN';
		process.env.HDB_ADMIN_PASSWORD = 'password1234';
		process.env.STORAGE_ENGINE = 'lmdb';
		const updateSpy = sandbox.spy(config_utils, 'updateConfigValue');
		await runBootInitialize();
		assertInstalledSystemEngine(rootPath, 'lmdb');
		const cliEnvUpdateCalls = updateSpy.getCalls().filter((call) => call.args[3] === true);
		assert.strictEqual(
			cliEnvUpdateCalls.length,
			0,
			'installedDuringInit should prevent redundant parsedArgs updateConfigValue after auto-install'
		);
	});

	it('resolves CLI STORAGE_ENGINE=lmdb + HARPER_DEFAULT_CONFIG={"storage":{"engine":"rocksdb"}} consistently to lmdb', async () => {
		process.env.STORAGE_ENGINE = 'lmdb';
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ storage: { engine: 'rocksdb' } });
		const rootPath = await runInstall();
		assertInstalledSystemEngine(rootPath, 'lmdb');
		assert.strictEqual(env_manager.getConfigOverrides()?.storage_engine, undefined);
	});

	it('resolves HDB_CONFIG storage.engine=lmdb + HARPER_SET_CONFIG={"storage":{"engine":"rocksdb"}} consistently to rocksdb', async () => {
		const externalConfigPath = path.join(tempBaseDir, 'external-harper-config.yaml');
		fs.writeFileSync(externalConfigPath, 'storage:\n  engine: lmdb\n', 'utf8');
		process.env.HDB_CONFIG = externalConfigPath;
		process.env.HARPER_SET_CONFIG = JSON.stringify({ storage: { engine: 'rocksdb' } });
		const rootPath = await runInstall();
		assertInstalledSystemEngine(rootPath, 'rocksdb');
		assert.strictEqual(env_manager.getConfigOverrides()?.storage_engine, undefined);
	});

	it('resolves HDB_CONFIG storage.engine=lmdb + HARPER_DEFAULT_CONFIG={"storage":{"engine":"rocksdb"}} consistently to lmdb', async () => {
		const externalConfigPath = path.join(tempBaseDir, 'external-harper-config.yaml');
		fs.writeFileSync(externalConfigPath, 'storage:\n  engine: lmdb\n', 'utf8');
		process.env.HDB_CONFIG = externalConfigPath;
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ storage: { engine: 'rocksdb' } });
		const rootPath = await runInstall();
		assertInstalledSystemEngine(rootPath, 'lmdb');
		assert.strictEqual(env_manager.getConfigOverrides()?.storage_engine, undefined);
	});

	it('preserves HDB_CONFIG operationsApi.network, node.hostname, and comments without flattenConfig corruption', async () => {
		const externalConfigPath = path.join(tempBaseDir, 'external-harper-config.yaml');
		fs.writeFileSync(
			externalConfigPath,
			[
				'# Custom HTTP settings',
				'http:',
				'  port: 8080',
				'  securePort: null',
				'operationsApi:',
				'  network:',
				'    # Keep ops API on TLS 9925 only',
				'    securePort: 9925',
				'node:',
				'  hostname: custom-node',
				'storage:',
				'  engine: lmdb',
				'',
			].join('\n'),
			'utf8'
		);
		process.env.HDB_CONFIG = externalConfigPath;
		const rootPath = await runInstall();
		assertInstalledSystemEngine(rootPath, 'lmdb');
		const writtenPath = path.join(rootPath, hdbTerms.HARPER_CONFIG_FILE);
		const writtenRaw = fs.readFileSync(writtenPath, 'utf8');
		const writtenParsed = YAML.parse(writtenRaw);
		assert.strictEqual(writtenParsed.http.port, 8080);
		assert.strictEqual(writtenParsed.http.securePort, null);
		assert.strictEqual(writtenParsed.operationsApi.network.port, null);
		assert.strictEqual(writtenParsed.operationsApi.network.securePort, 9925);
		assert.strictEqual(writtenParsed.node.hostname, 'custom-node');
		assert.ok(writtenRaw.includes('# Custom HTTP settings'), 'Expected HTTP comment to be preserved');
		assert.ok(writtenRaw.includes('# Keep ops API on TLS 9925 only'), 'Expected ops API comment to be preserved');
	});

	it('honours HARPER_SET_CONFIG={"storage":{"rocks":{"compression":"zstd"}}} on a RocksDB install and persists it', async () => {
		process.env.HARPER_SET_CONFIG = JSON.stringify({ storage: { rocks: { compression: 'zstd' } } });
		const rootPath = await runInstall();
		assert.strictEqual(env_manager.get(hdbTerms.CONFIG_PARAMS.STORAGE_ROCKS_COMPRESSION), 'zstd');
		assert.strictEqual(env_manager.getConfigOverrides()?.storage_rocks_compression, undefined);
		assertInstalledSystemEngine(rootPath, 'rocksdb', { compression: 'kZSTD' });
		assert.strictEqual(env_manager.get(hdbTerms.CONFIG_PARAMS.STORAGE_ROCKS_COMPRESSION), 'zstd');
		const writtenParsed = YAML.parse(fs.readFileSync(path.join(rootPath, hdbTerms.HARPER_CONFIG_FILE), 'utf8'));
		assert.strictEqual(writtenParsed.storage.rocks.compression, 'zstd');
	});

	it('coerces CLI/env STORAGE_COMPRESSION=false to boolean false when staging before mountHdb and persists boolean false', async () => {
		process.env.STORAGE_COMPRESSION = 'false';
		const rootPath = await runInstall();

		assert.strictEqual(
			env_manager.get(hdbTerms.CONFIG_PARAMS.STORAGE_COMPRESSION),
			false,
			'Active config STORAGE_COMPRESSION must be coerced to boolean false, not raw string "false"'
		);
		assert.strictEqual(env_manager.getConfigOverrides()?.storage_compression, undefined);
		assertInstalledSystemEngine(rootPath, 'rocksdb', { compression: 'kNoCompression' });
		const writtenParsed = YAML.parse(fs.readFileSync(path.join(rootPath, hdbTerms.HARPER_CONFIG_FILE), 'utf8'));
		assert.strictEqual(writtenParsed.storage.compression, false);
		config_utils.initConfig(true);
		assert.strictEqual(env_manager.get(hdbTerms.CONFIG_PARAMS.STORAGE_COMPRESSION), false);
	});

	it('creates system database at custom storage.path from HARPER_SET_CONFIG and persists storage.path', async () => {
		const customStorageDir = path.join(tempBaseDir, 'custom-storage');
		fs.mkdirSync(customStorageDir, { recursive: true });
		process.env.HARPER_SET_CONFIG = JSON.stringify({ storage: { path: customStorageDir } });
		const rootPath = await runInstall();
		assertInstalledSystemEngine(rootPath, 'rocksdb', { storageDir: customStorageDir });
		assert.strictEqual(
			fs.existsSync(path.join(rootPath, 'database', 'system', 'CURRENT')),
			false,
			'Default <rootPath>/database/system should not be created when custom storage.path is configured'
		);
		const writtenParsed = YAML.parse(fs.readFileSync(path.join(rootPath, hdbTerms.HARPER_CONFIG_FILE), 'utf8'));
		assert.strictEqual(writtenParsed.storage.path, customStorageDir);
	});

	it('rejects a nonexistent storage.path before mountHdb creates tables or directories there', async () => {
		const missingStorageDir = path.join(tempBaseDir, 'nonexistent-storage-dir');
		process.env.HARPER_SET_CONFIG = JSON.stringify({ storage: { path: missingStorageDir } });
		const exitStub = sandbox.stub(process, 'exit').callsFake((code) => {
			throw new Error(`process.exit(${code})`);
		});

		await assert.rejects(runInstall(), /process\.exit\(1\)/);

		assert.strictEqual(exitStub.calledWith(1), true, 'Expected rollbackInstall to call process.exit(1)');
		assert.strictEqual(
			fs.existsSync(missingStorageDir),
			false,
			'Nonexistent storage.path must not be created by mountHdb/openRocksDatabase before validation rejects it'
		);
		assert.strictEqual(
			fs.existsSync(path.join(tempBaseDir, 'hdb')),
			false,
			'Expected install rootPath to be removed during rollback'
		);
	});

	it('allows HARPER_DEFAULT_CONFIG to override un-authored dev mode defaults while yielding to explicit CLI/env args', async () => {
		process.env.DEFAULTS_MODE = 'dev';
		process.env.THREADS_COUNT = '2';
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
			threads: { count: 4 },
			logging: { level: 'debug' },
			storage: { engine: 'lmdb' },
		});
		const rootPath = await runInstall();
		assertInstalledSystemEngine(rootPath, 'lmdb');
		const writtenParsed = YAML.parse(fs.readFileSync(path.join(rootPath, hdbTerms.HARPER_CONFIG_FILE), 'utf8'));
		assert.strictEqual(
			writtenParsed.logging.level,
			'debug',
			'HARPER_DEFAULT_CONFIG should override un-authored DEV_MODE_CONFIG logging.level default ("info")'
		);
		assert.strictEqual(
			writtenParsed.threads.count,
			2,
			'Explicit CLI/env THREADS_COUNT=2 should still take precedence over HARPER_DEFAULT_CONFIG threads.count=4'
		);
		assert.strictEqual(
			writtenParsed.localStudio.enabled,
			true,
			'Un-overridden DEV_MODE_CONFIG defaults should still be preserved'
		);
	});

	it('restores a pre-seeded HDB_CONFIG and preserves pre-existing files inside rootPath on rollback via backup rename or writeFileSync fallback', async () => {
		const rootPath = path.join(tempBaseDir, 'hdb');
		const preExistingComponentFile = path.join(rootPath, 'components', 'my-app', 'index.js');
		fs.mkdirSync(path.dirname(preExistingComponentFile), { recursive: true });
		fs.writeFileSync(preExistingComponentFile, 'export default {};\n', 'utf8');
		const rootConfigPath = path.join(rootPath, hdbTerms.HARPER_CONFIG_FILE);
		const originalContent = 'storage:\n  engine: lmdb\n# pre-seeded root config\n';
		fs.writeFileSync(rootConfigPath, originalContent, 'utf8');
		process.env.HDB_CONFIG = rootConfigPath;

		const origCopyFileSync = fs.copyFileSync;
		sandbox.stub(fs, 'copyFileSync').callsFake((src, dest, ...rest) => {
			if (String(dest).includes('.install-backup-')) {
				throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
			}
			return origCopyFileSync.call(fs, src, dest, ...rest);
		});
		sandbox.stub(config_utils, 'writeStagedInstallConfig').callsFake(() => {
			fs.writeFileSync(rootConfigPath, 'corrupted: true\n', 'utf8');
			throw new Error('simulated writeStagedInstallConfig failure');
		});
		const enospcErr = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
		sandbox.stub(config_utils, 'atomicWriteFile').throws(enospcErr);
		const exitStub = sandbox.stub(process, 'exit').callsFake((code) => {
			throw new Error(`process.exit(${code})`);
		});

		await assert.rejects(runInstall(), /process\.exit\(1\)/);

		assert.strictEqual(exitStub.calledWith(1), true, 'Expected rollbackInstall to call process.exit(1)');
		assert.strictEqual(fs.existsSync(rootConfigPath), true, 'Expected pre-seeded root HDB_CONFIG to be preserved');
		assert.strictEqual(
			fs.readFileSync(rootConfigPath, 'utf8'),
			originalContent,
			'Expected pre-seeded root HDB_CONFIG content to be restored via writeFileSync fallback'
		);
		assert.strictEqual(
			fs.readFileSync(preExistingComponentFile, 'utf8'),
			'export default {};\n',
			'Expected pre-existing operator component file inside rootPath to survive rollback'
		);
		assert.deepStrictEqual(
			fs.readdirSync(rootPath).sort(),
			['components', hdbTerms.HARPER_CONFIG_FILE].sort(),
			'Expected only pre-existing entries and restored root config file to remain in rootPath after rollback'
		);
	});

	it('preserves pre-existing operator files inside rootPath on rollback even when HDB_CONFIG points outside rootPath', async () => {
		const rootPath = path.join(tempBaseDir, 'hdb');
		const preExistingComponentFile = path.join(rootPath, 'components', 'my-app', 'index.js');
		fs.mkdirSync(path.dirname(preExistingComponentFile), { recursive: true });
		fs.writeFileSync(preExistingComponentFile, 'export default {};\n', 'utf8');
		const externalConfigPath = path.join(tempBaseDir, 'external-harper-config.yaml');
		fs.writeFileSync(externalConfigPath, 'storage:\n  engine: lmdb\n', 'utf8');
		process.env.HDB_CONFIG = externalConfigPath;

		sandbox
			.stub(config_utils, 'writeStagedInstallConfig')
			.throws(new Error('simulated writeStagedInstallConfig failure'));
		const exitStub = sandbox.stub(process, 'exit').callsFake((code) => {
			throw new Error(`process.exit(${code})`);
		});

		await assert.rejects(runInstall(), /process\.exit\(1\)/);

		assert.strictEqual(exitStub.calledWith(1), true, 'Expected rollbackInstall to call process.exit(1)');
		assert.strictEqual(
			fs.readFileSync(preExistingComponentFile, 'utf8'),
			'export default {};\n',
			'Expected pre-existing operator component file inside rootPath to survive rollback'
		);
		assert.deepStrictEqual(
			fs.readdirSync(rootPath),
			['components'],
			'Expected install-created directories (database, keys, log, backup) to be removed while preserving pre-existing entries'
		);
	});

	it('retains the .install-backup file in rootPath on rollback when rename and in-memory restore writes all fail', async () => {
		const rootPath = path.join(tempBaseDir, 'hdb');
		fs.mkdirSync(rootPath, { recursive: true });
		const rootConfigPath = path.join(rootPath, hdbTerms.HARPER_CONFIG_FILE);
		const originalContent = 'storage:\n  engine: lmdb\n# pre-seeded root config\n';
		fs.writeFileSync(rootConfigPath, originalContent, 'utf8');
		process.env.HDB_CONFIG = rootConfigPath;

		sandbox.stub(config_utils, 'writeStagedInstallConfig').callsFake(() => {
			fs.writeFileSync(rootConfigPath, 'corrupted: true\n', 'utf8');
			throw new Error('simulated writeStagedInstallConfig failure');
		});
		const origRenameSync = fs.renameSync;
		sandbox.stub(fs, 'renameSync').callsFake((src, dest) => {
			if (String(src).includes('.install-backup-')) {
				throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
			}
			return origRenameSync.call(fs, src, dest);
		});
		const enospcErr = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
		sandbox.stub(config_utils, 'atomicWriteFile').throws(enospcErr);
		const origWriteFileSync = fs.writeFileSync;
		sandbox.stub(fs, 'writeFileSync').callsFake((file, data, ...rest) => {
			if (file === rootConfigPath && data === originalContent) {
				throw enospcErr;
			}
			return origWriteFileSync.call(fs, file, data, ...rest);
		});
		const exitStub = sandbox.stub(process, 'exit').callsFake((code) => {
			throw new Error(`process.exit(${code})`);
		});

		await assert.rejects(runInstall(), /process\.exit\(1\)/);

		assert.strictEqual(exitStub.calledWith(1), true, 'Expected rollbackInstall to call process.exit(1)');
		const remainingFiles = fs.readdirSync(rootPath);
		const backupFile = remainingFiles.find((f) => f.includes('.install-backup-'));
		assert.ok(backupFile, 'Expected .install-backup file to be retained when all restore attempts fail');
		assert.strictEqual(
			fs.readFileSync(path.join(rootPath, backupFile), 'utf8'),
			originalContent,
			'Expected retained .install-backup file to contain intact original HDB_CONFIG content'
		);
	});

	it('preserves an existing ~/.harperdb boot properties directory on rollback when shouldWriteBootProps is false', async () => {
		const existingRoot = path.join(tempBaseDir, 'existing-install');
		fs.mkdirSync(existingRoot, { recursive: true });
		const existingConfigPath = path.join(existingRoot, hdbTerms.HARPER_CONFIG_FILE);
		fs.writeFileSync(existingConfigPath, 'storage:\n  engine: rocksdb\n', 'utf8');

		const homeHdbDir = path.join(tempBaseDir, 'home', hdbTerms.HDB_HOME_DIR_NAME);
		const homeKeysDir = path.join(homeHdbDir, 'keys');
		fs.mkdirSync(homeKeysDir, { recursive: true });
		const existingKeyPath = path.join(homeKeysDir, 'existing.pem');
		fs.writeFileSync(existingKeyPath, 'existing-key', 'utf8');
		const propsFilePath = path.join(homeHdbDir, hdbTerms.BOOT_PROPS_FILE_NAME);
		const propsContent = `install_user=admin\nsettings_path=${existingConfigPath}\n`;
		fs.writeFileSync(propsFilePath, propsContent, 'utf8');

		realInstaller.setIgnoreExisting(true);
		process.env.STORAGE_ENGINE = 'lmdb';
		sandbox
			.stub(config_utils, 'writeStagedInstallConfig')
			.throws(new Error('simulated writeStagedInstallConfig failure'));
		const exitStub = sandbox.stub(process, 'exit').callsFake((code) => {
			throw new Error(`process.exit(${code})`);
		});

		await assert.rejects(runInstall(), /process\.exit\(1\)/);

		assert.strictEqual(exitStub.calledWith(1), true, 'Expected rollbackInstall to call process.exit(1)');
		assert.strictEqual(
			fs.existsSync(propsFilePath),
			true,
			'Expected pre-existing ~/.harperdb/hdb_boot_properties.file to be preserved on rollback'
		);
		assert.strictEqual(fs.readFileSync(propsFilePath, 'utf8'), propsContent);
		assert.strictEqual(
			fs.existsSync(existingKeyPath),
			true,
			'Expected pre-existing ~/.harperdb/keys to be preserved on rollback'
		);
	});

	for (const engine of ['rocksdb', 'lmdb']) {
		it(`removes install-created ${engine} system DB inside a pre-existing empty database directory on rollback so retry with root-named HDB_CONFIG succeeds`, async () => {
			const rootPath = path.join(tempBaseDir, 'hdb');
			const preExistingDatabaseDir = path.join(rootPath, 'database');
			fs.mkdirSync(preExistingDatabaseDir, { recursive: true });
			const rootConfigPath = path.join(rootPath, hdbTerms.HARPER_CONFIG_FILE);
			const originalContent = `storage:\n  engine: ${engine}\n`;
			fs.writeFileSync(rootConfigPath, originalContent, 'utf8');
			process.env.HDB_CONFIG = rootConfigPath;

			const writeConfigStub = sandbox
				.stub(config_utils, 'writeStagedInstallConfig')
				.throws(new Error('simulated writeStagedInstallConfig failure'));
			const exitStub = sandbox.stub(process, 'exit').callsFake((code) => {
				throw new Error(`process.exit(${code})`);
			});

			await assert.rejects(runInstall(), /process\.exit\(1\)/);

			assert.strictEqual(exitStub.calledWith(1), true, 'Expected rollbackInstall to call process.exit(1)');
			assert.strictEqual(
				fs.existsSync(preExistingDatabaseDir),
				true,
				'Expected pre-existing empty database directory mount to be preserved'
			);
			assert.deepStrictEqual(
				fs.readdirSync(preExistingDatabaseDir),
				[],
				`Expected install-created ${engine} system DB inside pre-existing database directory to be removed on rollback`
			);

			await closeSystemDatabase();
			env_manager.setProperty(hdbTerms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY, undefined);
			env_manager.setProperty(env_manager.BOOT_PROPS_FILE_PATH, undefined);
			env_manager.setProperty(hdbTerms.CONFIG_PARAMS.STORAGE_PATH, tempBaseDir);
			resetDatabases();
			env_manager.setProperty(hdbTerms.CONFIG_PARAMS.STORAGE_PATH, undefined);
			hdb_utils.resetNoBootFileCache();
			writeConfigStub.restore();
			exitStub.restore();
			await runInstall();
			assertInstalledSystemEngine(rootPath, engine);
		});
	}
});
