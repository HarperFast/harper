'use strict';

const sinon = require('sinon');
const chai = require('chai');
const assert = require('assert');
const fg = require('fast-glob');
const expect = chai.expect;
const rewire = require('rewire');
const directive_4_0_0_rw = rewire('../../../upgrade/directives/4-0-0');
const config_utils = require('../../../config/configUtils');
const path = require('path');
const fs = require('fs-extra');
const env = require('../../../utility/environment/environmentManager');
const environment_utility = require('../../../utility/lmdb/environmentUtility');
const lmdbCreateRecords = rewire('../../../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateRecords.js');
const InsertObject = require('../../../dataLayer/InsertObject');
const logger = require('../../../utility/logging/harper_logger');
const test_utils = require('../../../unitTests/test_utils');
const common_utils = require('../../../utility/common_utils');
const routes = require('../../../utility/clustering/routes');
const insert = require('../../../dataLayer/insert');
const person_data = require('../../personData');
const PERSON_ATTRIBUTES = ['id', 'first_name', 'state', 'age', 'alive', 'birth_month'];
const keys = require('../../../security/keys');
const upgrade_prompt = require('../../../upgrade/upgradePrompt');

const upgrade_script = rewire('../../../upgrade/directives/upgrade_scripts/4_0_0_reindex_script');
const { insertRecords } = require('../../../utility/lmdb/writeUtility');

const ROOT = 'yourcomputer/hdb';

describe.skip('Test 4-0-0 module', () => {
	const sandbox = sinon.createSandbox();
	const TEST_ERROR = 'Unit test error';
	let generate_keys_stub;
	let update_config_cert_stub;
	let upgrade_prompt_stub;
	let fs_move_stub;
	let generate_new_keys;

	before(() => {
		test_utils.restoreInitStub();
		generate_keys_stub = sandbox.stub(keys, 'generateKeys');
		update_config_cert_stub = sandbox.stub(keys, 'updateConfigCert');
		upgrade_prompt_stub = sandbox.stub(upgrade_prompt, 'upgradeCertsPrompt');
		fs_move_stub = sandbox.stub(fs, 'move');
		generate_new_keys = directive_4_0_0_rw.__get__('generateNewKeys');
		directive_4_0_0_rw.__set__('old_cert_path', path.join('user', 'test', 'cert_folder', 'cert.pem'));
		directive_4_0_0_rw.__set__('old_private_path', path.join('user', 'test', 'cert_folder', 'private.pem'));
	});

	after(() => {
		sandbox.restore();
	});
	describe('Test updateSettingsFile_4_0_0 function', () => {
		let updateSettingsFile_4_0_0;
		const old_config_obj = {
			rootpath: 'yourcomputer/hdb',
			operationsapi_network_port: 9900,
			operationsapi_tls_certificate: 'yourcomputer/keys/certificate.pem',
			operationsapi_tls_privatekey: 'yourcomputer/keys/privateKey.pem',
			operationsapi_network_https: true,
			operationsapi_network_cors: false,
			logging_level: 'fatal',
			logging_root: 'yourcomputer/log/hdb_log.log',
			clustering_enabled: false,
			operationsapi_processes: 12,
			operationsapi_network_corswhitelist: 'test',
			operationsapi_network_timeout: 120000,
			operationsapi_network_keepalivetimeout: 5000,
			operationsapi_network_headerstimeout: 60000,
			logging_auditlog: false,
			authentication_operationtokentimeout: '1d',
			authentication_refreshtokentimeout: '30d',
			ipc_network_port: 9384,
			//customfunctions_enabled: false,
			//customfunctions_network_port: 9926,
			//customfunctions_root: 'yourcomputer/custom_functions',
			customfunctions_processes: 12,
			logging_file: true,
			logging_stdstreams: false,
			certificate: 'can/i/do/this.pem',
			private_key: 'yes/you/can.pem',
		};
		const expected_settings_path = path.join(ROOT, '/config/settings.js');
		const expected_backup_path = path.join(ROOT, '/backup/4_0_0_upgrade_settings.bak');
		const old_settings_path = path.join(ROOT, '/config/settings.js');
		const expected_boot_props_path = path.join(ROOT, '/hdb_boot_properties.file');
		const test_user = 'test_user';

		let create_config_file_stub;
		let init_old_config_stub;
		let copy_sync_stub;
		let get_stub;
		let remove_sync_stub;
		let write_file_stub;
		let log_error_stub;
		let console_error_stub;
		let console_log_stub;
		let init_sync_stub;
		let get_props_file_path_stub;
		let access_sync_stub;
		let properties_reader_stub;

		before(() => {
			updateSettingsFile_4_0_0 = directive_4_0_0_rw.__get__('updateSettingsFile_4_0_0');
		});

		beforeEach(() => {
			get_stub = sandbox.stub(env, 'get').onFirstCall().returns(old_settings_path).onSecondCall().returns(ROOT);
			create_config_file_stub = sandbox.stub(config_utils, 'createConfigFile');
			init_old_config_stub = sandbox.stub(config_utils, 'initOldConfig').returns(old_config_obj);
			copy_sync_stub = sandbox.stub(fs, 'copySync');
			remove_sync_stub = sandbox.stub(fs, 'removeSync');
			write_file_stub = sandbox.stub(fs, 'writeFileSync');
			log_error_stub = sandbox.stub(logger, 'error');
			console_error_stub = sandbox.stub(console, 'error');
			console_log_stub = sandbox.stub(console, 'log');
			init_sync_stub = sandbox.stub(env, 'initSync');
			get_props_file_path_stub = sandbox.stub(common_utils, 'getPropsFilePath').returns(expected_boot_props_path);
			access_sync_stub = sandbox.stub(fs, 'accessSync');
			properties_reader_stub = sandbox.stub().returns({
				get: () => test_user,
			});
			directive_4_0_0_rw.__set__('PropertiesReader', properties_reader_stub);
		});

		afterEach(() => {
			sandbox.restore();
			sandbox.resetHistory();
		});

		it('Test correct params are being passed to createConfigFile', async () => {
			init_old_config_stub.returns(old_config_obj);
			await updateSettingsFile_4_0_0();

			expect(create_config_file_stub.args[0][0]).to.eql(old_config_obj);
		});

		it('Test correct params are being passed to copySync', async () => {
			await updateSettingsFile_4_0_0();
			expect(copy_sync_stub.args[0][0]).to.eql(expected_settings_path);
			expect(copy_sync_stub.args[0][1]).to.eql(expected_backup_path);
		});

		it('Test correct params are being passed to initOldConfig', async () => {
			await updateSettingsFile_4_0_0();
			expect(init_old_config_stub.args[0][0]).to.eql(old_settings_path);
		});

		it('Test correct params are being passed to writeFileSync', async () => {
			await updateSettingsFile_4_0_0();
			expect(write_file_stub.args[0][0]).to.eql(expected_boot_props_path);
		});

		it('Test initSync is called with force = true', async () => {
			await updateSettingsFile_4_0_0();
			expect(init_sync_stub.args[0][0]).to.be.true;
		});

		it('Test correct params are being passed to removeSync', async () => {
			await updateSettingsFile_4_0_0();
			expect(remove_sync_stub.called).to.be.true;
			expect(remove_sync_stub.args[0][0]).to.eql(path.join(ROOT, '/config'));
		});

		it('Test error is logged and thrown if backup fails', async () => {
			copy_sync_stub.throws(TEST_ERROR);
			let error;
			try {
				await updateSettingsFile_4_0_0();
			} catch (err) {
				error = err;
			}
			expect(error.name).to.equal(TEST_ERROR);
			expect(console_error_stub.args[0][0]).to.equal(
				'There was a problem writing the backup for the old settings file. Please check the log for details.'
			);
		});

		it('Test error is thrown if initOldConfig fails', async () => {
			init_old_config_stub.throws(TEST_ERROR);
			let error;
			try {
				await updateSettingsFile_4_0_0();
			} catch (err) {
				error = err;
			}
			expect(error.name).to.equal(TEST_ERROR);
		});

		it('Test error is thrown if createConfigFile fails', async () => {
			create_config_file_stub.throws(TEST_ERROR);
			let error;
			try {
				await updateSettingsFile_4_0_0();
			} catch (err) {
				error = err;
			}
			expect(error.name).to.equal(TEST_ERROR);
		});

		it('Test error is logged and thrown if writing boot props file fails', async () => {
			write_file_stub.throws(TEST_ERROR);
			let error;
			try {
				await updateSettingsFile_4_0_0();
			} catch (err) {
				error = err;
			}
			expect(error.name).to.equal(TEST_ERROR);
			expect(console_log_stub.args[3][0]).to.equal(
				'There was a problem updating the HarperDB boot properties file. Please check the log for details.'
			);
		});

		it('Test error is logged and thrown if initSync fails', async () => {
			init_sync_stub.throws(TEST_ERROR);
			let error;
			try {
				await updateSettingsFile_4_0_0();
			} catch (err) {
				error = err;
			}
			expect(error.name).to.equal(TEST_ERROR);
			expect(console_error_stub.firstCall.args[0]).to.equal(
				'Unable to initialize new properties. Please check the log for details.'
			);
		});

		it('Test error is logged and thrown if deleting old config dir fails', async () => {
			remove_sync_stub.throws(TEST_ERROR);
			let error;
			try {
				await updateSettingsFile_4_0_0();
			} catch (err) {
				error = err;
			}
			expect(error.name).to.equal(TEST_ERROR);
			expect(console_error_stub.args[0][0]).to.equal(
				'There was a problem deleting the old settings file and directory. Please check the log for details.'
			);
		});
	});

	describe('Test updateHdbNodesTable function', () => {
		const test_nodes = [
			{
				name: 'chicken1',
				host: 'test.io',
				port: 113345,
				subscriptions: [
					{
						channel: 'dev:dog',
						subscribe: false,
						publish: true,
					},
					{
						channel: 'dev:cat',
						subscribe: true,
						publish: true,
					},
				],
			},
			{
				name: 'chicken_2',
				host: '100.23.4.56',
				port: 11345,
				subscriptions: [
					{
						channel: 'dev:dog',
						subscribe: false,
						publish: true,
					},
				],
			},
			{
				name: 'dog',
				host: '100.23.4.53',
				port: 11344,
				subscriptions: [
					{
						channel: 'dev:dog',
						subscribe: false,
						publish: true,
					},
				],
			},
		];
		let search_by_value_stub = sandbox.stub().resolves(test_nodes);
		let update_stub;
		let set_routes_stub;
		let update_nodes;
		let console_error_stub;

		before(() => {
			set_routes_stub = sandbox.stub(routes, 'setRoutes');
			update_stub = sandbox.stub(insert, 'update');
			update_nodes = directive_4_0_0_rw.__get__('updateNodes');
			directive_4_0_0_rw.__set__('p_search_by_value', search_by_value_stub);
			console_error_stub = sandbox.stub(console, 'error');
		});

		afterEach(() => {
			sandbox.resetHistory();
		});

		it('Test update and set routes are called with correct values', async () => {
			await update_nodes();
			expect(update_stub.args[0][0].records[0]).to.eql({
				name: 'chicken1',
				subscriptions: [
					{
						schema: 'dev',
						table: 'dog',
						publish: true,
						subscribe: false,
					},
					{
						schema: 'dev',
						table: 'cat',
						publish: true,
						subscribe: true,
					},
				],
				system_info: {
					hdb_version: '3.x.x',
					node_version: undefined,
					platform: undefined,
				},
			});
			expect(update_stub.args[0][0].records[1]).to.eql({
				name: 'chicken_2',
				subscriptions: [
					{
						schema: 'dev',
						table: 'dog',
						publish: true,
						subscribe: false,
					},
				],
				system_info: {
					hdb_version: '3.x.x',
					node_version: undefined,
					platform: undefined,
				},
			});
			expect(update_stub.args[0][0].records[2]).to.eql({
				name: 'dog',
				subscriptions: [
					{
						schema: 'dev',
						table: 'dog',
						publish: true,
						subscribe: false,
					},
				],
				system_info: {
					hdb_version: '3.x.x',
					node_version: undefined,
					platform: undefined,
				},
			});
			expect(set_routes_stub.args[0][0]).to.eql({
				server: 'hub',
				routes: [
					{
						host: 'test.io',
						port: 113345,
					},
					{
						host: '100.23.4.56',
						port: 11345,
					},
					{
						host: '100.23.4.53',
						port: 11344,
					},
				],
			});
		});

		it('Test invalid node name is caught', async () => {
			const nodes_bad_name = test_utils.deepClone(test_nodes);
			nodes_bad_name[0].name = 'dev.dog';
			search_by_value_stub.resolves(nodes_bad_name);
			let error;
			try {
				await update_nodes();
			} catch (err) {
				error = err;
			}

			expect(error).to.equal(
				"Node name 'dev.dog' is invalid, must not contain ., * or >. Please change name and try again."
			);
			expect(console_error_stub.args[1][0]).to.equal(
				'There was a problem updating the hdb_nodes table. Please check the log for details.'
			);
		});

		it('Test error from set routes is caught and messaged logged', async () => {
			search_by_value_stub.resolves(test_nodes);
			set_routes_stub.throws(new Error('trouble setting routes'));
			let error;
			try {
				await update_nodes();
			} catch (err) {
				error = err;
			}
			expect(error.message).to.eql('trouble setting routes');
			expect(console_error_stub.args[0][0]).to.equal(
				'There was a problem setting the clustering routes. Please check the log for details.'
			);
		});
	});

	it('Test generateNewKeys function calls generate_keys if prompted to', async () => {
		upgrade_prompt_stub.resolves(true);
		await generate_new_keys();
		expect(fs_move_stub.getCall(0).firstArg).to.equal(path.join('user', 'test', 'cert_folder', 'cert.pem'));
		expect(fs_move_stub.getCall(0).lastArg).to.equal(path.join('user', 'test', 'cert_folder', 'cert.bak'));
		expect(fs_move_stub.getCall(1).firstArg).to.equal(path.join('user', 'test', 'cert_folder', 'private.pem'));
		expect(fs_move_stub.getCall(1).lastArg).to.equal(path.join('user', 'test', 'cert_folder', 'private.bak'));
		expect(generate_keys_stub.called).to.be.true;
	});

	it('Test generateKeys does not generate keys if prompted to', async () => {
		upgrade_prompt_stub.resolves(false);
		await generate_new_keys();
		expect(update_config_cert_stub.args[0]).to.eql([
			path.join('user', 'test', 'cert_folder', 'cert.pem'),
			path.join('user', 'test', 'cert_folder', 'private.pem'),
			undefined,
		]);
	});

	it('Test generateNewKeys function error is correctly handled', async () => {
		upgrade_prompt_stub.resolves(true);
		generate_keys_stub.throws(new Error('Test error generate keys'));
		let error;
		try {
			await generate_new_keys();
		} catch (err) {
			error = err;
		}

		expect(error.message).to.equal('Test error generate keys');
	});
});

describe('Test reindexing lmdb', () => {
	let test_path = path.join(__dirname, 'upgrade_scripts/reindexTestDir');
	before(async () => {
		for (let filename of await fg(['**/dog.m*', '**/hdb_*.m*'], { cwd: test_path })) {
			await fs.unlink(path.join(test_path, filename));
		}
		upgrade_script.__set__('env_mngr', {
			getHdbBasePath() {
				return test_path;
			},
		});
	});
	after(async () => {
		for (let filename of await fg(['**/dog.m*', '**/hdb_*.m*', '**/lock.mdb'], { cwd: test_path })) {
			await fs.unlink(path.join(test_path, filename));
		}
		try {
			await fs.rm(path.join(test_path, '4_0_0_upgrade_tmp'), { recursive: true });
		} catch (e) {}
	});
	it('reindexes lmdb databases from old databases', async () => {
		let result = await upgrade_script(false);
		assert.strictEqual(result, 'Reindexing for 4.0.0 upgrade complete');
		let new_env = await environment_utility.openEnvironment(
			path.join(__dirname, 'upgrade_scripts/reindexTestDir/schema/dev'),
			'dog'
		);
		try {
			let dbis = environment_utility.listDBIs(new_env);
			assert.deepStrictEqual(dbis, [
				'__createdtime__',
				'__updatedtime__',
				'adorable',
				'age',
				'breed_id',
				'dog_name',
				'id',
				'owner_id',
				'weight_lbs',
			]);
		} finally {
			await environment_utility.closeEnvironment(new_env);
		}
		let txn_env = await environment_utility.openEnvironment(
			path.join(__dirname, 'upgrade_scripts/reindexTestDir/transactions/dev'),
			'dog'
		);
		try {
			let dbis = environment_utility.listDBIs(txn_env);
			assert.deepStrictEqual(dbis, ['hash_value', 'timestamp', 'user_name']);
		} finally {
			await environment_utility.closeEnvironment(txn_env);
		}
		let schema_env = await environment_utility.openEnvironment(
			path.join(__dirname, 'upgrade_scripts/reindexTestDir/schema/system'),
			'hdb_schema'
		);
		try {
			let schema_dbi = await environment_utility.openDBI(schema_env, 'name');
			for (let { key: id, value: record } of schema_dbi.getRange({ start: false })) {
				assert.strictEqual(typeof record.name, 'string');
			}
		} finally {
			await environment_utility.closeEnvironment(schema_env);
		}
		let table_env = await environment_utility.openEnvironment(
			path.join(__dirname, 'upgrade_scripts/reindexTestDir/schema/system'),
			'hdb_table'
		);
		try {
			let table_dbi = await environment_utility.openDBI(table_env, 'id');
			for (let { key: id, value: record } of table_dbi.getRange({ start: false })) {
				assert.strictEqual(typeof record.name, 'string');
				assert.strictEqual(typeof record.schema, 'string');
			}
		} finally {
			await environment_utility.closeEnvironment(table_env);
		}
		let attribute_env = await environment_utility.openEnvironment(
			path.join(__dirname, 'upgrade_scripts/reindexTestDir/schema/system'),
			'hdb_attribute'
		);
		try {
			let attribute_dbi = await environment_utility.openDBI(attribute_env, 'id');
			for (let { key: id, value: record } of attribute_dbi.getRange({ start: false })) {
				assert.strictEqual(typeof record.schema, 'string');
				assert.strictEqual(typeof record.table, 'string');
				assert.strictEqual(typeof record.attribute, 'string');
			}
		} finally {
			await environment_utility.closeEnvironment(attribute_env);
		}
	});
});
