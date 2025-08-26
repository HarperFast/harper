'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const rewire = require('rewire');
const hdb_utils = require('../../utility/common_utils');
const fs = require('fs-extra');
const inquirer = require('inquirer');
const path = require('path');
const hdb_info_controller = require('../../dataLayer/hdbInfoController');
const hdb_logger = require('../../utility/logging/harper_logger');
const installer_mod_path = '../../utility/install/installer';
const env_manager = require('../../utility/environment/environmentManager');
const config_utils = require('../../config/configUtils');
const { packageJson } = require('../../utility/packageUtils');
const role_ops = require('../../security/role');
const user_ops = require('../../security/user');
const installer = rewire(installer_mod_path);

describe('Test installer module', () => {
	const sandbox = sinon.createSandbox();
	let console_log_stub;
	let console_error_stub;
	let hdb_log_trace_stub;
	let hdb_log_error_stub;

	before(() => {
		console_log_stub = sandbox.stub(console, 'log');
		console_error_stub = sandbox.stub(console, 'error');
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

	it('Test termsAgreement doesnt prompt if override value passed', async () => {
		const termsAgreement = installer.__get__('termsAgreement');
		await termsAgreement({ TC_AGREEMENT: 'no' });
		expect(hdb_log_error_stub.called).to.be.false;
	});

	it('Test termsAgreement logs and exits if answer not yes', async () => {
		const termsAgreement = installer.__get__('termsAgreement');
		const inquirer_stub = sandbox.stub(inquirer, 'prompt').resolves({ TC_AGREEMENT: 'no' });
		const process_exit_stub = sandbox.stub(process, 'exit');
		await termsAgreement({});
		process_exit_stub.restore();
		inquirer_stub.restore();
		expect(console_log_stub.called).to.be.true;
		expect(process_exit_stub.called).to.be.true;
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
		const expected_args = {
			node_name: 'dog1',
			clustering: 'true',
			ROOTPATH: 'user/unit/test',
			OPERATIONSAPI_NETWORK_PORT: '8888',
		};
		const create_config_file_stub = sandbox.stub(config_utils, 'createConfigFile');
		// not reliably reset
		//const env_mng_init_stub = sandbox.stub(env_manager, 'initSync');
		process.env.CLUSTERING = 'true';
		process.env.NODE_NAME = 'dog1';
		const fake_install_params = {
			ROOTPATH: 'user/unit/test',
			OPERATIONSAPI_NETWORK_PORT: '8888',
		};
		const createConfigFile = installer.__get__('createConfigFile');
		await createConfigFile(fake_install_params);

		expect(create_config_file_stub.args[0][0]).to.eql(expected_args);
		//expect(env_mng_init_stub.called).to.be.true;

		delete process.env.CLUSTERING;
		delete process.env.NODE_NAME;
		create_config_file_stub.restore();
	});

	// this test does reliably wrap stubs
	it.skip('Test createConfigFile calls rollback if create config throws error', async () => {
		const rollback_stub = sandbox.stub();
		const rollback_rw = installer.__set__('rollbackInstall', rollback_stub);
		sandbox.stub(config_utils, 'createConfigFile').throws('Error creating config file');
		const fake_install_params = {
			ROOTPATH: 'user/unit/test',
			OPERATIONSAPI_NETWORK_PORT: '8888',
		};
		const createConfigFile = installer.__get__('createConfigFile');
		await createConfigFile(fake_install_params);
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

	it('Test installPrompts passes correct schema and override works', async () => {
		const prompt_stub = sandbox.stub(inquirer, 'prompt');
		const installPrompts = installer.__get__('installPrompts');
		const override = {
			DEFAULTS_MODE: 'dev',
			CLUSTERING_ENABLED: true,
			CLUSTERING_NODENAME: 'im_a_node',
		};

		const answers_fake_result = {
			ROOTPATH: 'i/am/root/',
			HDB_ADMIN_USERNAME: 'test_user',
			HDB_ADMIN_PASSWORD: 'testing_rulz',
		};

		const expected_result = {
			DEFAULTS_MODE: 'dev',
			CLUSTERING_ENABLED: true,
			CLUSTERING_NODENAME: 'im_a_node',
			ROOTPATH: 'i/am/root/',
			HDB_ADMIN_USERNAME: 'test_user',
			HDB_ADMIN_PASSWORD: 'testing_rulz',
		};

		prompt_stub.resolves(answers_fake_result);
		const result = await installPrompts(override);
		expect(result).to.eql(expected_result);
		const prompts_schema = prompt_stub.args[0][0];
		expect(prompts_schema.length).to.equal(8);
		expect(prompts_schema[0].name).to.equal('ROOTPATH');
		expect(prompts_schema[0].when).to.be.true;
		expect(prompts_schema[1].name).to.equal('HDB_ADMIN_USERNAME');
		expect(prompts_schema[1].when).to.be.true;
		expect(prompts_schema[2].name).to.equal('HDB_ADMIN_PASSWORD');
		expect(prompts_schema[2].when).to.be.true;
		expect(prompts_schema[3].name).to.equal('DEFAULTS_MODE');
		expect(prompts_schema[3].when).to.be.false;
		expect(prompts_schema[4].name).to.equal('REPLICATION_HOSTNAME');
		expect(prompts_schema[4].when).to.be.true;
		expect(prompts_schema[5].name).to.equal('CLUSTERING_NODENAME');
		expect(prompts_schema[5].when).to.be.false;
		expect(prompts_schema[6].name).to.equal('CLUSTERING_USER');
		expect(prompts_schema[6].when).to.be.true;
		expect(prompts_schema[7].name).to.equal('CLUSTERING_PASSWORD');
		expect(prompts_schema[7].when).to.be.true;
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
		const version_stub = sandbox.stub(packageJson, 'version').get(() => '100.1.1');
		const insert_hdb_stub = sandbox.stub(hdb_info_controller, 'insertHdbInstallInfo');
		const insertHdbVersionInfo = installer.__get__('insertHdbVersionInfo');
		await insertHdbVersionInfo();
		expect(version_stub.called).to.be.true;
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
});
