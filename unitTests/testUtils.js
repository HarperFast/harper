const path = require('node:path');
const fs = require('fs-extra');
const sinon = require('sinon');
const uuid = require('uuid').v4;
const env = require('#src/utility/environment/environmentManager');
const assert = require('node:assert');
const COMMON_TEST_TERMS = require('./commonTestTerms.js');
const systemSchema = require('../json/systemSchema.json');
const { table: ensure_table, resetDatabases, resolveDatabaseStorageRoot } = require('#src/resources/databases');
const terms = require('#src/utility/hdbTerms');
const harperBridge = require('#src/dataLayer/harperBridge/harperBridge').default;
const { getDatabases } = require('#src/resources/databases');
const { handleHDBError } = require('#src/utility/errors/hdbError');
const { PRIVATEKEY_PEM_NAME } = require('#src/utility/terms/certificates');
const { materializePerPidRoot, removePerPidRoot } = require('./perPidRoot.js');

let envMgrInitSyncStub;

const MOCK_ARGS_ERROR_MSG =
	'Null, undefined, and/or empty string argument values not allowed when building mock HDB for testing';
const UNIT_TEST_DIR = __dirname;
const ENV_DIR_NAME = 'envDir';
const ENV_DIR_PATH = path.join(UNIT_TEST_DIR, ENV_DIR_NAME);
const PID_DIR_PATH = path.join(ENV_DIR_PATH, process.pid.toString());
const BASE_SCHEMA_PATH = path.join(PID_DIR_PATH, 'schema');
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

	// Set the code rather than calling process.exit() from inside an 'exit' listener: that
	// re-enters exit and terminates immediately, which skips every listener still queued behind
	// this one (including mocha.init.js's did-the-run-finish check) and, on Windows, discards
	// whatever is still pending on the stdout pipe. Assigning process.exitCode here has the same
	// effect on the process's exit status.
	process.prependListener('exit', (code) => {
		if (code === 0) {
			// Clean up explicitly rather than relying solely on the preload's own 'exit'
			// listener: this one is prepended, so it runs first, and assigning exitCode
			// (instead of calling process.exit(), per the comment above) lets the preload's
			// listener still run too — this just guarantees the ~98 suites that call
			// preTestPrep don't depend on load order for it.
			removePerPidRoot();
			process.exitCode = unhandledRejectionExitCode;
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
		if (!partial_teardown) await fs.remove(PID_DIR_PATH);
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
	setTestPath(PID_DIR_PATH);
	return PID_DIR_PATH;
}

/**
 * Returns the path to the test root path that will be used for testing
 * @returns String representing the path value to the mock lmdb system directory
 */
function setupTestDBPath() {
	let dbPath = materializePerPidRoot();
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, dbPath);
	env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, path.join(dbPath, 'database'));
	const databasePaths = {
		data: { path: dbPath },
		dev: { path: dbPath },
		test: { path: dbPath },
		test2: { path: dbPath },
	};
	env.setProperty(terms.CONFIG_PARAMS.DATABASES, databasePaths);
	resetDatabases();
	return dbPath;
}

/**
 * Seeds the per-PID system database the way an install would: the standard system tables
 * (hdb_user, hdb_role, etc.), a super_user role with an active admin user (which
 * authorizeLocal/getSuperUser() need to authorize local requests), and self-signed
 * certificates (which the TLS servers, e.g. MQTT's secure port, need). Suites that
 * exercise code requiring the system tables (e.g. setUsersWithRolesCache) call this
 * after setupTestDBPath() instead of borrowing an installed Harper root's system
 * database.
 */
function systemDatabaseOnDisk() {
	const storageRoot = resolveDatabaseStorageRoot('system');
	// 'system' is a RocksDB directory, 'system.mdb' the LMDB file
	for (const name of ['system', 'system.mdb']) {
		const candidate = path.join(storageRoot, name);
		if (!fs.existsSync(candidate)) continue;
		const stats = fs.statSync(candidate);
		if (stats.isFile() ? stats.size > 0 : fs.readdirSync(candidate).length > 0) return true;
	}
	return false;
}

async function seededAdminIsUsable() {
	const admin = await getDatabases().system.hdb_user?.get('admin');
	if (!admin?.active) return false;
	// admin.role holds a role id: a deleted-and-recreated super_user role gets a fresh id,
	// leaving an active admin that getSuperUser() no longer recognizes
	const role = admin.role && (await getDatabases().system.hdb_role.get(admin.role));
	return !!role?.permission?.super_user;
}

async function ensureSystemTables() {
	// the guard checks the seed's final artifacts — key file, tables, a usable admin, and
	// the config repoint that is its last step — so a partial seed, or one a mid-run
	// tearDownMockDB() removed, re-runs in full; every step below is idempotent
	const keysDir = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME);
	const testKeyPath = path.join(keysDir, 'unitTestPrivateKey.pem');
	if (
		env.get(terms.CONFIG_PARAMS.TLS_PRIVATEKEY) === testKeyPath &&
		fs.existsSync(testKeyPath) &&
		getDatabases().system?.hdb_role &&
		(await seededAdminIsUsable())
	) {
		return;
	}
	materializePerPidRoot();
	// decide on the ON-DISK database, not the cached handle: after a tearDownMockDB() the
	// module-level cache still answers, and seeding through handles whose files were
	// unlinked writes nothing to disk. Close them first so the reopen recreates the files.
	const tablesInCache = !!getDatabases().system?.hdb_role;
	if (tablesInCache && !systemDatabaseOnDisk()) {
		// The cache answers for a database whose files are gone — a tearDownMockDB() removed
		// the root while its handles were open. Seeding through those handles writes to
		// unlinked files and reports success, and reopening them from here recurses inside
		// databases.table(). Fail loudly: the fix belongs at the call site, which must seed
		// before tearing down, or run in its own process.
		throw new Error(
			'ensureSystemTables(): the system database is open but its files are gone — ' +
				'a tearDownMockDB() removed the per-PID root mid-process. Seed before tearing down.'
		);
	}
	if (!tablesInCache) {
		const mountHdb = require('#src/utility/mount_hdb').default;
		await mountHdb(env.getHdbBasePath());
	}
	const { addRole, alterRole, getRoleByName } = require('#src/security/role');
	const user = require('#src/security/user');
	try {
		await addRole({ role: 'super_user', permission: { super_user: true } });
	} catch (error) {
		if (!error.message?.includes('already exists')) throw error;
		// addRole cannot touch an existing row: repair a super_user role whose permission
		// no longer grants super_user, or the guard above would stay false forever
		const existing = await getRoleByName('super_user');
		if (existing && !existing.permission?.super_user) {
			await alterRole({ id: existing.id, role: 'super_user', permission: { super_user: true } });
		}
	}
	try {
		await user.addUser({ username: 'admin', password: 'password', role: 'super_user', active: true });
	} catch (error) {
		if (!error.message?.includes('already exists')) throw error;
		// addUser cannot touch an existing row: repair a deactivated admin, or one whose
		// role id points at a role that no longer exists
		await user.alterUser({ username: 'admin', password: 'password', role: 'super_user', active: true });
	}
	const keys = require('#src/security/keys');
	await keys.generateCertsKeys();
	// Rename the generated key: generateCertsKeys() names it privateKey.pem, the same name
	// loadCertificates() registers for any ambient config's tls.privateKey in the
	// in-process privateKeys cache, which would shadow this key and pair the fresh
	// certificates with an unrelated one (ERR_OSSL_X509_KEY_VALUES_MISMATCH, zero TLS
	// contexts). Repoint the per-PID config at the renamed key so cert records, the
	// config file, and the key watcher agree.
	if (fs.existsSync(path.join(keysDir, PRIVATEKEY_PEM_NAME))) {
		fs.renameSync(path.join(keysDir, PRIVATEKEY_PEM_NAME), testKeyPath);
	}
	for await (const cert of getDatabases().system.hdb_certificate.search([])) {
		if (cert.private_key_name === PRIVATEKEY_PEM_NAME) {
			await keys.setCertTable({ ...cert, private_key_name: path.basename(testKeyPath) });
		}
	}
	require('#src/config/configUtils').updateConfigValue(terms.CONFIG_PARAMS.TLS_PRIVATEKEY, testKeyPath);
	env.setProperty(terms.CONFIG_PARAMS.TLS_PRIVATEKEY, testKeyPath);
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

/**
 * Writes a throwaway RSA keypair where getJWTRSAKeys() looks for it, and returns a cleanup function
 * that removes exactly the files it created.
 *
 * The keys directory is shared with unitTests/utility/install/checkJWTTokensExist.test.js, whose
 * happy path asserts those files are ABSENT (it expects accessSync to throw ENOENT). Mocha runs
 * every file in one process against one base path, so a test that writes keys and does not clean up
 * silently breaks that suite depending on file order — which is exactly how it broke, and why this
 * lives here instead of being copy-pasted into each caller.
 */
function installTestJwtKeys() {
	const { generateKeyPairSync } = require('node:crypto');
	const passphrase = 'test-passphrase';
	const { privateKey, publicKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
	});
	const keysDir = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME);
	fs.mkdirpSync(keysDir);

	const written = [
		[path.join(keysDir, terms.JWT_ENUM.JWT_PRIVATE_KEY_NAME), privateKey],
		[path.join(keysDir, terms.JWT_ENUM.JWT_PUBLIC_KEY_NAME), publicKey],
		[path.join(keysDir, terms.JWT_ENUM.JWT_PASSPHRASE_NAME), passphrase],
	];
	for (const [file, contents] of written) fs.writeFileSync(file, contents);

	return function removeTestJwtKeys() {
		for (const [file] of written) fs.removeSync(file);
	};
}

module.exports = {
	changeProcessToBinDir,
	deepClone,
	mochaAsyncWrapper,
	preTestPrep,
	installTestJwtKeys,
	cleanUpDirectories,
	createMockDB,
	tearDownMockDB,
	setGlobalSchema,
	setTestPath,
	getMockTestPath,
	setupTestDBPath,
	ensureSystemTables,
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
