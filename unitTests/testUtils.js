const path = require('node:path');
const fs = require('fs-extra');
const sinon = require('sinon');
const uuid = require('uuid').v4;
const env = require('#js/utility/environment/environmentManager');
const assert = require('node:assert');
const COMMON_TEST_TERMS = require('./commonTestTerms.js');
const systemSchema = require('../json/systemSchema.json');
const { table: ensure_table, resetDatabases } = require('#src/resources/databases');
const terms = require('#src/utility/hdbTerms');
const harperBridge = require('#js/dataLayer/harperBridge/harperBridge');
const { isMainThread } = require('node:worker_threads');
const { getDatabases } = require('#src/resources/databases');
const { handleHDBError } = require('#js/utility/errors/hdbError');

let envMgrInitSyncStub;

const MOCK_ARGS_ERROR_MSG =
	'Null, undefined, and/or empty string argument values not allowed when building mock HDB for testing';
const UNIT_TEST_DIR = __dirname;
const ENV_DIR_NAME = 'envDir';
const ENV_DIR_PATH = path.join(UNIT_TEST_DIR, ENV_DIR_NAME);
const BASE_SCHEMA_PATH = path.join(ENV_DIR_PATH, 'schema');
const BASE_SYSTEM_PATH = path.join(BASE_SCHEMA_PATH, 'system');

/**
 * This needs to be called near the top of our unit tests.  Most will fail when loading harper modules due to the
 * properties reader trying to look in bin.  We can iterate on this to make it smarter if needed, for now this works.
 */
function changeProcessToBinDir() {
	try {
		process.chdir(path.join(process.cwd(), 'bin'));
		console.log(`Current directory ${process.cwd()}`);
	} catch {}
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
function preTestPrep(testConfigObj) {
	let unhandledRejectionExitCode = 0;
	if (envMgrInitSyncStub) {
		envMgrInitSyncStub.restore();
	}
	envMgrInitSyncStub = sinon.stub(env, 'initSync').callsFake(() => {
		env.initTestEnvironment(testConfigObj);
	});
	process.on('unhandledRejection', (reason) => {
		// Ignore @datadog/pprof errors - the module has no native build for Electron test environment
		if (reason?.message?.includes('No native build was found for runtime=electron')) {
			return;
		}
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
	env.initTestEnvironment(testConfigObj);
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
		await harperBridge.createRecords(insert_records_obj);

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
 * @param partial_teardown
 * @returns {Promise<void>}
 */
async function tearDownMockDB(envs = undefined, partial_teardown = false) {
	try {
		if (envs !== undefined) {
			for (const Table of envs) {
				try {
					await Table.dropTable();
				} catch {}
			}
		}

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
	} else if (!global.hdb_schema[schema]) {
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

/**
 * sets Harper config for a test sandbox path
 * @param testPath
 */
function setTestPath(testPath) {
	env.setProperty(terms.CONFIG_PARAMS.ROOTPATH, testPath);
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, testPath);
	env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, path.join(testPath, 'database'));
	fs.mkdirpSync(testPath);
	fs.writeFileSync(path.join(testPath, 'harperdb-config.yaml'), JSON.stringify({}));
}

/**
 * gets a dir path in the unit test folder that can be used for testing
 * @returns {string}
 */
function getMockTestPath() {
	const testPath = path.join(UNIT_TEST_DIR, ENV_DIR_NAME, process.pid.toString());
	setTestPath(testPath);
	return testPath;
}

/**
 * Returns the path to the test root path that will be used for testing
 * @returns String representing the path value to the mock lmdb system directory
 */
function setupTestDBPath() {
	let dbPath = path.join(UNIT_TEST_DIR, ENV_DIR_NAME, process.pid.toString());
	if (!fs.existsSync(dbPath)) {
		fs.mkdirSync(dbPath, { recursive: true });
	}
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, dbPath);
	env.setProperty(terms.CONFIG_PARAMS.DATABASES, {
		data: { path: dbPath },
		dev: { path: dbPath },
		test: { path: dbPath },
		test2: { path: dbPath },
	});
	resetDatabases();
	if (isMainThread) {
		process.on('exit', function () {
			tearDownMockDB();
		});
	}
	return dbPath;
}

function sortAsc(data, sort_by) {
	if (sort_by) {
		return data.sort((a, b) => a[sort_by] - b[sort_by]);
	}

	return data.sort((a, b) => a - b);
}

function sortDesc(data, sort_by) {
	if (sort_by) {
		return data.sort((a, b) => b[sort_by] - a[sort_by]);
	}

	return data.sort((a, b) => b - a);
}

function sortAttrKeyMap(attrs, hash = 'id') {
	const final_arr = attrs.sort();
	const hash_index = final_arr.indexOf(hash);
	final_arr.splice(hash_index, 1);
	return [hash, ...final_arr];
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

module.exports = {
	changeProcessToBinDir,
	deepClone,
	mochaAsyncWrapper,
	preTestPrep,
	cleanUpDirectories,
	createMockDB,
	tearDownMockDB,
	setGlobalSchema,
	setTestPath,
	getMockTestPath,
	setupTestDBPath,
	setupTestDBPath,
	sortAsc,
	sortDesc,
	sortAttrKeyMap,
	testError,
	testHDBError,
	generateHDBError,
	assertErrorSync,
	assertErrorAsync,
	assignObjectToMap,
	orderedArray,
	COMMON_TEST_TERMS,
	ENV_DIR_PATH,
};
