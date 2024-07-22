'use strict';
require('./fixRewire');
const path = require('path');
const fs = require('fs-extra');
const sinon = require('sinon');
const uuid = require('uuid').v4;
const assert = require('assert');
const rewire = require('rewire');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const { spawn } = require('child_process');
const COMMON_TEST_TERMS = require('./commonTestTerms');
const { platform } = require('os');

const LeafConfigObject = require('../server/nats/utility/LeafConfigObject');
const SysUserObject = require('../server/nats/utility/SysUserObject');
const HdbUserObject = require('../server/nats/utility/HdbUserObject');
const systemSchema = require('../json/systemSchema.json');
const env = require('../utility/environment/environmentManager');
const { table: ensure_table, resetDatabases } = require('../resources/databases');
const terms = require('../utility/hdbTerms');
const nats_terms = rewire('../server/nats/utility/natsTerms');
const crypto_hash = require('../security/cryptoHash');
const { handleHDBError } = require('../utility/errors/hdbError');
const environment_utility = require('../utility/lmdb/environmentUtility');
const pm2_utils = require('../utility/processManagement/processManagement');
const lmdb_create_schema = require('../dataLayer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const { createTable, createRecords } = require('../dataLayer/harperBridge/harperBridge');
const nats_utils = require('../server/nats/utility/natsUtils');
const config_utils = require('../config/configUtils');
const user = require('../security/user');
const { isMainThread } = require('worker_threads');
const { getDatabases } = require('../resources/databases');
let lmdb_schema_env = undefined;
let lmdb_table_env = undefined;
let lmdb_attribute_env = undefined;

let env_mgr_init_sync_stub = undefined;
let sandbox;
let leaf_server_term_rw;

const MOCK_ARGS_ERROR_MSG =
	'Null, undefined, and/or empty string argument values not allowed when building mock HDB for testing';
const UNIT_TEST_DIR = __dirname;
const ENV_DIR_NAME = 'envDir';
const ENV_DIR_PATH = path.join(__dirname, 'envDir');
const BASE_SCHEMA_PATH = path.join(ENV_DIR_PATH, 'schema');
const BASE_TXN_PATH = path.join(ENV_DIR_PATH, 'transactions');
const BASE_SYSTEM_PATH = path.join(BASE_SCHEMA_PATH, 'system');

const TEMP_TEST_DIR = path.resolve(__dirname, './server/nats/tempTestDir');
const TEMP_CLUSTERING_TEST_DIR = path.join(TEMP_TEST_DIR, 'clustering');
const DEPENDENCIES_PATH = path.resolve(__dirname, '../dependencies');
const NATS_SERVER_PATH = path.join(
	DEPENDENCIES_PATH,
	`${process.platform}-${process.arch}`,
	nats_terms.NATS_BINARY_NAME
);
const NATS_TEST_SERVER_VALUES = {
	CLUSTER_USER: 'unit-Test!Cluster@User',
	CLUSTER_USER_PASS: 'p@ssWor/@d',
};

const NATS_TEST_CONFIG_FILES = {
	HUB_SERVER: 'hub_test.json',
	LEAF_SERVER: 'leaf_test.json',
};

/**
 * This needs to be called near the top of our unit tests.  Most will fail when loading harper modules due to the
 * properties reader trying to look in bin.  We can iterate on this to make it smarter if needed, for now this works.
 */
function changeProcessToBinDir() {
	try {
		process.chdir(path.join(process.cwd(), 'bin'));
		console.log(`Current directory ${process.cwd()}`);
	} catch (e) {
		// no-op, we are probably already in bin
	}
}

/**
 This is a simple, naive clone implementation.  It should never, ever! be used in prod.
 */
function deepClone(a) {
	return JSON.parse(JSON.stringify(a));
}

/**
 * Wrap an async function with a try/catch to reduce the amount of test code.  This is OK for unit tests, but prod code should be explicitly wrapped.
 * @param fn
 * @returns {function(*=)}
 */
let mochaAsyncWrapper = (fn) => (done) => {
	fn.call().then(done, (err) => {
		done(err);
	});
};

/**
 * Call this function near the top of any unit test to assign the unhandledReject event handler (this is due to a bug in Node).
 * This will prevent tests bombing with an unhandled promise rejection in some cases.
 */
function preTestPrep(test_config_obj) {
	let unhandledRejectionExitCode = 0;
	if (env_mgr_init_sync_stub) {
		env_mgr_init_sync_stub.restore();
	}
	env_mgr_init_sync_stub = sinon.stub(env, 'initSync').callsFake(() => {
		env.initTestEnvironment(test_config_obj);
	});
	process.on('unhandledRejection', (reason) => {
		console.log('unhandled rejection:', reason);
		unhandledRejectionExitCode = 1;
		throw reason;
	});

	process.prependListener('exit', (code) => {
		if (code === 0) {
			process.exit(unhandledRejectionExitCode);
		}
	});
	// Try to change to bin
	changeProcessToBinDir();
	env.initTestEnvironment(test_config_obj);
}

function makeTheDir(path_value) {
	if (!fs.existsSync(path_value)) {
		fs.mkdirSync(path_value);
	}
}

/**
 * Call this function to delete all directories under the specified path.  This is a synchronous function.
 * @param target_path The path to the directory to remove
 */
function cleanUpDirectories(target_path) {
	if (!target_path) return;
	//Just in case
	if (target_path === '/') return;
	let files = [];
	if (fs.existsSync(target_path)) {
		try {
			files = fs.readdirSync(target_path);
			for (let i = 0; i < files.length; i++) {
				let file = files[i];
				let curPath = path.join(target_path, file);
				if (fs.lstatSync(curPath).isDirectory()) {
					// recurse
					cleanUpDirectories(curPath);
				} else {
					fs.unlinkSync(curPath);
				}
			}
			fs.rmdirSync(target_path);
		} catch (e) {
			console.error(e);
		}
	}
}

/**
 * gets a dir path in the unit test folder that can be used for testing
 * @returns {string}
 */
function getMockTestPath() {
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, path.join(UNIT_TEST_DIR, ENV_DIR_NAME));
	env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, path.join(UNIT_TEST_DIR, ENV_DIR_NAME));
	return path.join(UNIT_TEST_DIR, ENV_DIR_NAME);
}

/**
 * Returns the path to the test root path that will be used for testing
 * @returns String representing the path value to the mock lmdb system directory
 */
function getMockLMDBPath() {
	let lmdb_path = path.join(UNIT_TEST_DIR, ENV_DIR_NAME, process.pid.toString());
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, lmdb_path);
	env.setProperty(terms.CONFIG_PARAMS.DATABASES, { data: { path: lmdb_path }, dev: { path: lmdb_path } });
	resetDatabases();
	if (isMainThread) {
		process.on('exit', function () {
			tearDownMockDB();
		});
	}
	return lmdb_path;
}

/**
 * Validates that arguments passed into `createMockFS()` are not null, undefined, or "" - throws error, if so
 * @param argArray Array of arg values
 */
function validateMockArgs(argArray) {
	for (let i = 0; i < argArray.length; i++) {
		if (argArray[i] === null || argArray[i] === undefined || argArray[i] === '') {
			throw new Error(MOCK_ARGS_ERROR_MSG);
		}
	}
}

function CreateSchemaObj(schema) {
	this.operation = 'create_schema';
	this.schema = schema;
}

function CreateTableObj(schema, table, hash_attribute) {
	this.operation = 'create_table';
	this.schema = schema;
	this.table = table;
	this.hash_attribute = hash_attribute;
}

function CreateSystemTableObj(schema, table, hash_attribute) {
	this.name = table;
	this.schema = schema;
	this.id = uuid();
	this.hash_attribute = hash_attribute;
	this.residence = '*';
}

function InsertRecordsObj(schema, table, records) {
	this.operation = 'insert';
	this.schema = schema;
	this.table = table;
	this.records = records;
}

/**
 * Creates a mock LMDB HDB environment/DB
 * NOTE: Make sure to use tearDownMockDB after using this function.
 * @param hash_attribute
 * @param schema
 * @param table
 * @param test_data
 * @returns {Promise<*[]>}
 */
async function createMockDB(hash_attribute, schema, table, test_data) {
	try {
		validateMockArgs([hash_attribute, schema, table, test_data]);

		let env_array = [];
		let attributes = [];
		let unique_attributes = [];
		for (const record of test_data) {
			for (const attr in record) {
				if (!unique_attributes.includes(attr)) {
					unique_attributes.push(attr);
					attributes.push({ attribute: attr, isPrimaryKey: attr === hash_attribute });
				}
			}
		}

		if (global.hdb_schema === undefined) {
			global.hdb_schema = { system: systemSchema };
		}

		await fs.mkdirp(BASE_SYSTEM_PATH);
		await fs.mkdirp(BASE_SCHEMA_PATH);

		env_array.push(
			await ensure_table({
				database: schema,
				table,
				attributes,
				path: BASE_SCHEMA_PATH,
			})
		);

		const insert_records_obj = new InsertRecordsObj(schema, table, test_data);
		await createRecords(insert_records_obj);

		return env_array;
	} catch (err) {
		console.error('Error creating mock DB for unit tests.');
		console.error(err);
		throw err;
	}
}

/**
 * Tears down a mock LMDB HDB environment/DB
 * @param envs
 * @returns {Promise<void>}
 */
async function tearDownMockDB(envs = undefined, partial_teardown = false) {
	try {
		if (envs !== undefined) {
			for (const Table of envs) {
				try {
					await Table.delete();
					// eslint-disable-next-line no-empty
				} catch (err) {}
			}
		}

		if (lmdb_schema_env !== undefined) {
			await lmdb_schema_env.close();
		}

		if (lmdb_table_env !== undefined) {
			await lmdb_table_env.close();
		}

		if (lmdb_attribute_env !== undefined) {
			await lmdb_attribute_env.close();
		}

		lmdb_schema_env = undefined;
		lmdb_table_env = undefined;
		lmdb_attribute_env = undefined;

		delete global.hdb_schema;
		global.lmdb_map = undefined;
		if (!partial_teardown) await fs.remove(ENV_DIR_PATH);
	} catch (err) {
		console.error('Error tearing down mock DB used for unit tests');
		console.error(err);
		throw err;
	}
}

function setGlobalSchema(hash_attribute, schema, table, attributes_keys) {
	const attributes = attributes_keys.map((attr_key) => ({ attribute: attr_key }));
	const table_id = uuid();
	let databases = getDatabases();
	if (!databases[schema]) databases[schema] = {};
	databases[schema][table] = { attributes, primaryKey: hash_attribute };
	if (global.hdb_schema === undefined) {
		global.hdb_schema = {
			[schema]: {
				[table]: {
					hash_attribute: `${hash_attribute}`,
					id: `${table_id}`,
					name: `${table}`,
					schema: `${schema}`,
					attributes: attributes,
				},
			},
			system: {
				hdb_table: {
					hash_attribute: 'id',
					name: 'hdb_table',
					schema: 'system',
					residence: ['*'],
					attributes: [
						{
							attribute: 'id',
						},
						{
							attribute: 'name',
						},
						{
							attribute: 'hash_attribute',
						},
						{
							attribute: 'schema',
						},
					],
				},
				hdb_drop_schema: {
					hash_attribute: 'id',
					name: 'hdb_drop_schema',
					schema: 'system',
					residence: ['*'],
				},
				hdb_attribute: {
					hash_attribute: 'id',
					name: 'hdb_attribute',
					schema: 'system',
					residence: ['*'],
				},
				hdb_schema: {
					hash_attribute: 'name',
					name: 'hdb_schema',
					schema: 'system',
					residence: ['*'],
					attributes: [
						{
							attribute: 'name',
						},
						{
							attribute: 'createddate',
						},
					],
				},
				hdb_user: {
					hash_attribute: 'username',
					name: 'hdb_user',
					schema: 'system',
					residence: ['*'],
				},
				hdb_role: {
					hash_attribute: 'id',
					name: 'hdb_user',
					schema: 'system',
					residence: ['*'],
				},
				hdb_license: {
					hash_attribute: 'license_key',
					name: 'hdb_license',
					schema: 'system',
				},
				hdb_info: {
					hash_attribute: 'info_id',
					name: 'hdb_info',
					schema: 'system',
					residence: ['*'],
					attributes: [
						{
							attribute: 'info_id',
						},
						{
							attribute: 'data_version_num',
						},
						{
							attribute: 'hdb_version_num',
						},
					],
				},
				hdb_nodes: {
					hash_attribute: 'name',
					residence: ['*'],
				},
			},
		};
	} else {
		if (!global.hdb_schema[schema]) {
			global.hdb_schema[schema] = {
				[table]: {
					hash_attribute: `${hash_attribute}`,
					id: `${table_id}`,
					name: `${table}`,
					schema: `${schema}`,
					attributes: attributes,
				},
			};
		} else {
			global.hdb_schema[schema][table] = {
				hash_attribute: `${hash_attribute}`,
				id: `${table_id}`,
				name: `${table}`,
				schema: `${schema}`,
				attributes: attributes,
			};
		}
	}
}

function sortDesc(data, sort_by) {
	if (sort_by) {
		return data.sort((a, b) => b[sort_by] - a[sort_by]);
	}

	return data.sort((a, b) => b - a);
}

function sortAsc(data, sort_by) {
	if (sort_by) {
		return data.sort((a, b) => a[sort_by] - b[sort_by]);
	}

	return data.sort((a, b) => a - b);
}

function sortAttrKeyMap(attrs, hash = 'id') {
	const final_arr = attrs.sort();
	const hash_index = final_arr.indexOf(hash);
	final_arr.splice(hash_index, 1);
	return [hash, ...final_arr];
}

function generateAPIMessage(msg_type_enum) {
	let generated_msg = undefined;
	switch (msg_type_enum) {
		case terms.OPERATIONS_ENUM.CREATE_SCHEMA:
			break;
		case terms.OPERATIONS_ENUM.CREATE_TABLE:
			break;
		case terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE:
			break;

		default:
			break;
	}
	return generated_msg;
}

function getHTTPSCredentials() {
	return {
		key:
			'-----BEGIN RSA PRIVATE KEY-----\n' +
			'MIIEpQIBAAKCAQEA0rzroDdeK/p5vf79zGyrJk0/21wdR/FJufOj/V17T7gyyj0Q\n' +
			'wlA71cqYv2kLzgZ51kBtnY2T3aARWRiORFE7hZqKDuGt753letSX4HuOHH3sWeAu\n' +
			'hVzPKQspG978w+EgnwlxtqydhlrK2hV2V9ToPf4QlbAzFcZD5XvkPvjQqrcy5o3o\n' +
			'dCMcrU+QLUPo15kpEeYRGN8I06EpfWx8QvB2AKbKSuZN2SrIpfLtat9TmZwf6fii\n' +
			'mRriik3FlphKlj7y+rzMxuNIDI1QMf0DRWLR18AvKbPov0Ad211dpVzbfnrbD5HA\n' +
			't9HYCs2HR+f1XCNMQ77BqUnQrOrmg2junARFBQIDAQABAoIBAQCLgpoSdNUZFDao\n' +
			'OzjVrlMXhihyFecki24ddlfoEYzi17R4AjkoCmmyPO8mOGqiN9NMrVZj6Sgsnh0d\n' +
			'+I2mWIipCAfBllHJwaP7zuXErMcFwa9ISItDqo9SQpsyYkq/ejhYUK5BGsEmAtEr\n' +
			'0u2Hc+FTuPBNyFnpXlnwgDY4IgwyFuZB/t9mcn2Y0V8k2a5bCnykAwH5Nn+4LPgh\n' +
			'AklRu8PmlQg/4IrtuknpX4WDSD3GuFxZrcJbZcxlX43XrYVWB/nmcb/zBeeCP8uu\n' +
			'3DsKUmPAjGeXcEDPVlBpaQPhl7A8Aubnnm9uT6jxuCpNteOw2sxOGFgWcgXxclSf\n' +
			'Gemy7t45AoGBAOtwnqTN1Wc/FpBNuFmPe4VMVV55YqveocKvrx88Z+xSlal8bxVJ\n' +
			'80DjT8YWpQxq2YdkE60G5vDjVnmFn1K9mMlRFsWgshSnfT7A3fm8nrjJjN2GAvL3\n' +
			'brCNdT+9rLvKvh+93d331NFzmaqn2pAlIpfnElFgAgskwK2C36dNKrCrAoGBAOUk\n' +
			'E3AhuzXXfnjzWq85DXxpjfjHZOWrCVYU689yxB+ZLG5Mb+lNUxN5jos1UnnKqbN5\n' +
			'83lt2tLeQRHwW7OUdHUIkP8DgoG9sVRrtH9+g6bmAVQweoU5gK+Lkg5V+6nPvAGm\n' +
			'eTRrqds8vbWrsuWPAA94+v9AT5fphZwKL7Qz+cEPAoGBAML+BQYtS181SvS8yb+z\n' +
			'K/QcYl/aXLRHsOVTJ9DQ8KkzRKyYWE/jbUoCeWFwA8YjAII3imw1WTOMtWP0HR4j\n' +
			'1NR3CksnahXdGcfNaIqbg0E7/CTEBtE/yDcFEWR3LQZjRc94KrbZuTK3cT97wXK8\n' +
			'rsfsIqmuwEKGb+XEjIM9T+v9AoGACL6Qs1XGNC7OF8WJr2go+Jd6oITTd+RIDe3s\n' +
			'ddU2YNJSnL70Al4+Dl80LmHRjO5L/ZpozTiBAk0TBKE8jqTasOCrz9+NanAXxVX6\n' +
			'5GaqlYLviAv1kQH5xDk6UKu9V+SikxmMRJDbQY+W2cj8ocAMS4rdYUJOB0kVHThS\n' +
			'S7k0DccCgYEAo1EVPdc41HNDSyIxDZVq+LGWM9Ypz0jLoO283swk5WiXyupHlnpy\n' +
			'VQkcIptaQKhYN/yw4otFGX+efp05DkJbdo4EjV7YmHHKo2vdeF87i2clSu8BWGod\n' +
			'J2OZW7+gJXzxs7FpWZHp8pxzXBwDj7dbLtB2yCjh5T7vTe6bGeP6usU=\n' +
			'-----END RSA PRIVATE KEY-----\n',
		cert:
			'-----BEGIN CERTIFICATE-----\n' +
			'MIIEDzCCAvegAwIBAgIBATANBgkqhkiG9w0BAQUFADBtMRQwEgYDVQQDEwtoYXJw\n' +
			'ZXJkYi5pbzELMAkGA1UEBhMCVVMxETAPBgNVBAgTCENvbG9yYWRvMQ8wDQYDVQQH\n' +
			'EwZEZW52ZXIxFjAUBgNVBAoTDUhhcnBlckRCLCBJbmMxDDAKBgNVBAsTA0hEQjAe\n' +
			'Fw0yMDEyMTExNTU0MDJaFw0yMTEyMTExNTU0MDJaMG0xFDASBgNVBAMTC2hhcnBl\n' +
			'cmRiLmlvMQswCQYDVQQGEwJVUzERMA8GA1UECBMIQ29sb3JhZG8xDzANBgNVBAcT\n' +
			'BkRlbnZlcjEWMBQGA1UEChMNSGFycGVyREIsIEluYzEMMAoGA1UECxMDSERCMIIB\n' +
			'IjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0rzroDdeK/p5vf79zGyrJk0/\n' +
			'21wdR/FJufOj/V17T7gyyj0QwlA71cqYv2kLzgZ51kBtnY2T3aARWRiORFE7hZqK\n' +
			'DuGt753letSX4HuOHH3sWeAuhVzPKQspG978w+EgnwlxtqydhlrK2hV2V9ToPf4Q\n' +
			'lbAzFcZD5XvkPvjQqrcy5o3odCMcrU+QLUPo15kpEeYRGN8I06EpfWx8QvB2AKbK\n' +
			'SuZN2SrIpfLtat9TmZwf6fiimRriik3FlphKlj7y+rzMxuNIDI1QMf0DRWLR18Av\n' +
			'KbPov0Ad211dpVzbfnrbD5HAt9HYCs2HR+f1XCNMQ77BqUnQrOrmg2junARFBQID\n' +
			'AQABo4G5MIG2MAoGAQAEBTADAQH/MAsGA1UdDwQEAwIC9DA7BgNVHSUENDAyBggr\n' +
			'BgEFBQcDAQYIKwYBBQUHAwIGCCsGAQUFBwMDBggrBgEFBQcDBAYIKwYBBQUHAwgw\n' +
			'EQYJYIZIAYb4QgEBBAQDAgD3MCwGA1UdEQQlMCOGG2h0dHA6Ly9leGFtcGxlLm9y\n' +
			'Zy93ZWJpZCNtZYcEfwAAATAdBgNVHQ4EFgQUMEWOqB/VcD5j63kC2pRimmMH9Fcw\n' +
			'DQYJKoZIhvcNAQEFBQADggEBAD0/oDrYW3rHvZRRX+IXgJ55yCEvrTWkoWoE5qeZ\n' +
			'L2R7K9cQyUeVLK+95TwnUhYb7iyHnG6DEXWrGfWtLNVihWhjXSwVlYmdSO6OoOye\n' +
			'hc7ztLGFtc7zlYeb3xmg8sVYXC0nPjNaOtRc+TACwD7TJIrEyGkuyaIsSuIVlKuc\n' +
			'b4I5NwpED0UOL/qOfXSyTyKsvhd78VPO/PZlMK2uwHniLhhOCaedhJzfGt9XzrJ0\n' +
			'P9kAKD3/uvPtZSz77jAdIk/1hwv+QUzahhhYHUcWL7N+nreYyigAdFI0/2Z/BcKO\n' +
			'KA+qobbatVaK0aihycZhrwyomOGBy5X/TpVTQWCvdNCL0Hg=\n' +
			'-----END CERTIFICATE-----',
	};
}

/**
 * Helper function that tests for correct error instance and its message.
 * @param test_func
 * @param error_msg
 * @returns {Promise<boolean>}
 */
async function testError(test_func, error_msg) {
	let error;
	try {
		console.log(await test_func);
	} catch (err) {
		error = err;
	}

	return error instanceof Error && error.message === error_msg;
}

/**
 * Helper function that tests for correct HdbError instance and the http_resp_msg.
 * @param test_func
 * @param error_msg
 * @returns {Promise<boolean>}
 */
async function testHDBError(test_func, expected_error) {
	let error;
	let results;
	try {
		results = await test_func;
	} catch (err) {
		error = err;
	}

	assert.deepStrictEqual(error, expected_error);
	return results;
}

function generateHDBError(err_msg, status_code) {
	return handleHDBError(new Error(), err_msg, status_code);
}

async function assertErrorAsync(test_func, args, error_object, message) {
	let error;
	let result;
	try {
		result = await test_func.apply(null, args);
	} catch (e) {
		error = e;
	}

	assert.deepStrictEqual(error, error_object, message);
	return result;
}

function assertErrorSync(test_func, args, error_object, message) {
	let error;
	let result;
	try {
		result = test_func.apply(null, args);
	} catch (e) {
		error = e;
	}

	assert.deepStrictEqual(error, error_object, message);
	return result;
}

function asKeyValueArray(iterable) {
	let values = Array.from(iterable);
	return [values.map((v) => v.key), values.map((v) => v.value)];
}
/**
 * assigns objects to an null object, which is how we create objects in lmdb
 * @returns {*[]}
 * @param objects
 */
function assignObjectToNullObject(...objects) {
	objects.unshift(Object.create(null));
	return Object.assign.apply(null, objects);
}

/**
 * assigns objects to an null object, which is how we create objects in lmdb
 * @returns {Map}
 * @param objects
 */
function assignObjectToMap(object) {
	let results = new Map();
	for (let key in object) {
		results.set(isNaN(key) ? key : +key, object[key]);
	}
	return results;
}

/**
 * Return ordered array
 * @param iterator
 * @returns {unknown[]}
 */
function orderedArray(iterator) {
	let array = Array.from(iterator);
	if (Array.isArray(array[0])) return array.sort((a, b) => (a[0] > b[0] ? 1 : -1));
	if (array[0]?.id) return array.sort((a, b) => (a.id > b.id ? 1 : -1));
	return array;
}

/**
 * Creates stubbed value for an UpgradeObject
 *
 * @param data_ver
 * @param upgrade_ver
 * @returns {{data_version, upgrade_version}}
 */
function generateUpgradeObj(data_ver, upgrade_ver) {
	return {
		data_version: data_ver,
		upgrade_version: upgrade_ver,
	};
}

function requireUncached(module) {
	delete require.cache[require.resolve(module)];
	return require(module);
}

/**
 * Starts a Nats leaf server that can be used for testing.
 * @param ls_net_port
 * @param node_name
 * @param hsln_net_port
 * @returns {Promise<void>}
 */
async function launchTestLeafServer(ls_net_port = 9991, node_name = 'testLeafServer', hsln_net_port = 9992) {
	await fs.mkdirp(TEMP_CLUSTERING_TEST_DIR);
	await generateTestKeys(TEMP_CLUSTERING_TEST_DIR);
	const test_ca_path = path.join(TEMP_CLUSTERING_TEST_DIR, 'keys', 'caCertificate.pem');
	const test_cert_path = path.join(TEMP_CLUSTERING_TEST_DIR, 'keys', 'certificate.pem');
	const test_private_key_path = path.join(TEMP_CLUSTERING_TEST_DIR, 'keys', 'privateKey.pem');
	const test_leaf_pid_path = path.join(TEMP_CLUSTERING_TEST_DIR, 'leaf.pid');
	const test_leaf_js_store_path = path.join(TEMP_CLUSTERING_TEST_DIR, 'leaf');
	const user1_name_encoded = encodeURIComponent(NATS_TEST_SERVER_VALUES.CLUSTER_USER);
	const user1_pass_uri = encodeURIComponent(NATS_TEST_SERVER_VALUES.CLUSTER_USER_PASS);
	const user2_pass = 'passwordAgain';
	const leafnode_remotes_url_sys = `tls://${user1_name_encoded}-admin:${user1_pass_uri}@0.0.0.0:${hsln_net_port}`;
	const leafnode_remotes_url_hdb = `tls://${user1_name_encoded}:${user1_pass_uri}@0.0.0.0:${hsln_net_port}`;
	const sys_users = [
		new SysUserObject(NATS_TEST_SERVER_VALUES.CLUSTER_USER, NATS_TEST_SERVER_VALUES.CLUSTER_USER_PASS),
		new SysUserObject('secondaryTestClusterUser', user2_pass),
	];

	const hdb_users = [
		new HdbUserObject(NATS_TEST_SERVER_VALUES.CLUSTER_USER, NATS_TEST_SERVER_VALUES.CLUSTER_USER_PASS),
		new HdbUserObject('secondaryTestClusterUser', user2_pass),
	];

	const new_leaf_config = new LeafConfigObject(
		ls_net_port,
		node_name,
		test_leaf_pid_path,
		test_leaf_js_store_path,
		[leafnode_remotes_url_sys],
		[leafnode_remotes_url_hdb],
		sys_users,
		hdb_users,
		test_cert_path,
		test_private_key_path,
		test_ca_path,
		true
	);

	const leaf_config_path = path.join(TEMP_CLUSTERING_TEST_DIR, NATS_TEST_CONFIG_FILES.LEAF_SERVER);
	await fs.writeJson(leaf_config_path, new_leaf_config);

	const pm2_leaf_server_config = {
		name: 'nats_test_leaf_server',
		script: NATS_SERVER_PATH,
		args: `-c ${leaf_config_path}`,
		exec_mode: 'fork',
		env: { [terms.PROCESS_NAME_ENV_PROP]: terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF },
		out_file: '/dev/null',
		error_file: '/dev/null',
		instances: 1,
	};

	await pm2_utils.start(pm2_leaf_server_config);
}

async function generateTestKeys(test_root) {
	const keys_test_path = path.join(test_root, 'keys');
	await fs.mkdirp(keys_test_path);
	await fs.mkdirp(path.join(ENV_DIR_PATH, 'keys'));
	const keys = rewire('../security/keys');
	const get_hdb_path_stub = sinon.stub().returns(test_root);
	const update_config_stub = sinon.stub();
	const get_hdb_path_rw = keys.__set__('env_manager.getHdbBasePath', get_hdb_path_stub);
	const update_config_rw = keys.__set__('config_utils.updateConfigValue', update_config_stub);

	let rep_ca;
	let rep_cert;
	const all_certs = await keys.listCertificates();
	for (const cert of all_certs) {
		if (cert.is_self_signed && cert.is_authority) rep_ca = cert.certificate;
		if (cert.is_self_signed && !cert.is_authority) rep_cert = cert.certificate;
	}

	if (!rep_ca || !rep_cert) {
		throw new Error('Unable to find test cert for setting up test nats server');
	}

	const r_path = config_utils.getConfigFromFile(terms.CONFIG_PARAMS.ROOTPATH);

	const private_key = await fs.readFile(
		path.join(config_utils.getConfigFromFile(terms.CONFIG_PARAMS.ROOTPATH), 'keys', 'privateKey.pem')
	);
	await fs.writeFile(path.join(keys_test_path, 'caCertificate.pem'), rep_ca);
	await fs.writeFile(path.join(keys_test_path, 'certificate.pem'), rep_cert);
	await fs.writeFile(path.join(keys_test_path, 'privateKey.pem'), private_key);
	await fs.writeFile(path.join(ENV_DIR_PATH, 'keys', 'caCertificate.pem'), rep_ca);
	await fs.writeFile(path.join(ENV_DIR_PATH, 'keys', 'certificate.pem'), rep_cert);
	await fs.writeFile(path.join(ENV_DIR_PATH, 'keys', 'privateKey.pem'), private_key);
	//await keys.generateKeys();
	env.setProperty(terms.CONFIG_PARAMS.CLUSTERING_TLS_CERT_AUTH, path.join(keys_test_path, 'caCertificate.pem'));
	env.setProperty(terms.CONFIG_PARAMS.CLUSTERING_TLS_CERTIFICATE, path.join(keys_test_path, 'certificate.pem'));
	env.setProperty(terms.CONFIG_PARAMS.CLUSTERING_TLS_PRIVATEKEY, path.join(keys_test_path, 'privateKey.pem'));
	get_hdb_path_rw();
	update_config_rw();
	rewire('../utility/install/installer');
}

function setFakeClusterUser() {
	const fake_cluster_user = {
		active: true,
		hash: crypto_hash.encrypt(NATS_TEST_SERVER_VALUES.CLUSTER_USER_PASS),
		decrypt_hash: NATS_TEST_SERVER_VALUES.CLUSTER_USER_PASS,
		uri_encoded_d_hash: encodeURIComponent(NATS_TEST_SERVER_VALUES.CLUSTER_USER_PASS),
		password: 'somepass',
		role: {
			id: '58aa11-b761-4ade-8a7d-e9123',
			permission: {
				cluster_user: true,
			},
			role: 'cluster_user',
		},
		username: NATS_TEST_SERVER_VALUES.CLUSTER_USER,
		uri_encoded_name: encodeURIComponent(NATS_TEST_SERVER_VALUES.CLUSTER_USER),
		sys_name: NATS_TEST_SERVER_VALUES.CLUSTER_USER + '-admin',
		sys_name_encoded: encodeURIComponent(NATS_TEST_SERVER_VALUES.CLUSTER_USER) + '-admin',
	};

	sandbox = sinon.createSandbox();
	sandbox.stub(user, 'getClusterUser').resolves(fake_cluster_user);
	env.setProperty(terms.CONFIG_PARAMS.ROOTPATH, TEMP_CLUSTERING_TEST_DIR);
	env.setProperty(terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT, 9991);
	env.setProperty(terms.CONFIG_PARAMS.CLUSTERING_USER, 'test_cluster_user');
	env.setProperty(terms.CONFIG_PARAMS.CLUSTERING_NODENAME, 'testLeafServer');
	const nats_terms = rewire('../server/nats/utility/natsTerms');

	leaf_server_term_rw = nats_terms.__set__('NATS_CONFIG_FILES', NATS_TEST_CONFIG_FILES);

	const get_config_from_file_stub = sandbox.stub(config_utils, 'getConfigFromFile');
	get_config_from_file_stub.withArgs(terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT).returns(9991);
	get_config_from_file_stub.withArgs(terms.CONFIG_PARAMS.CLUSTERING_USER).returns('test_cluster_user');
	get_config_from_file_stub.withArgs(terms.CONFIG_PARAMS.CLUSTERING_NODENAME).returns('testLeafServer');
	get_config_from_file_stub.withArgs(terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT).returns(7788);
}

function unsetFakeClusterUser() {
	sandbox.restore();
	leaf_server_term_rw();
}

/**
 * Stops the Nats test leaf server.
 * @returns {Promise<void>}
 */
async function stopTestLeafServer() {
	const nats_connection = await nats_utils.getConnection();
	if (nats_connection) {
		try {
			await nats_connection.close();
			// eslint-disable-next-line no-empty
		} catch (err) {}
	}

	try {
		// I don't
		await runCommand(`${NATS_SERVER_PATH} --signal stop`, undefined);
	} catch (err) {
		console.error(err);
	}
	try {
		await pm2_utils.stop('nats_test_leaf_server');
		await pm2_utils.kill();
		fs.removeSync(TEMP_TEST_DIR);
	} catch (err) {
		console.error(err);
	}
}

/**
 * Runs a bash script in a new shell
 * @param {String} command - the command to execute
 * @param {String=} cwd - path to the current working directory
 * @returns {Promise<*>}
 */
async function runCommand(command, cwd = undefined) {
	const { stdout, stderr } = await exec(command, { cwd });

	if (stderr) {
		throw new Error(stderr.replace('\n', ''));
	}

	return stdout.replace('\n', '');
}

function restoreInitStub() {
	if (env_mgr_init_sync_stub) {
		env_mgr_init_sync_stub.restore();
	}
}

function arrayOfValues(iterator) {
	return Array.from(iterator.map((e) => e.value));
}

module.exports = {
	arrayOfValues,
	restoreInitStub,
	changeProcessToBinDir,
	deepClone,
	mochaAsyncWrapper,
	preTestPrep,
	cleanUpDirectories,
	createMockDB,
	tearDownMockDB,
	setGlobalSchema,
	makeTheDir,
	getMockTestPath,
	getMockLMDBPath,
	sortAsc,
	sortDesc,
	sortAttrKeyMap,
	testError,
	testHDBError,
	generateHDBError,
	generateAPIMessage,
	getHTTPSCredentials,
	assertErrorSync,
	assertErrorAsync,
	generateUpgradeObj,
	assignObjecttoNullObject: assignObjectToNullObject,
	assignObjectToMap,
	orderedArray,
	asKeyValueArray,
	requireUncached,
	stopTestLeafServer,
	launchTestLeafServer,
	setFakeClusterUser,
	unsetFakeClusterUser,
	COMMON_TEST_TERMS,
	NATS_TEST_SERVER_VALUES,
	ENV_DIR_PATH,
};
