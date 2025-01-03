'use strict';
const path = require('path');
const fs = require('fs-extra');
const log = require('./logging/harper_logger');
const fs_extra = require('fs-extra');
const os = require('os');
const net = require('net');
const RecursiveIterator = require('recursive-iterator');
const terms = require('./hdbTerms');
const ps_list = require('./psList');
const papa_parse = require('papaparse');
const moment = require('moment');
const { inspect } = require('util');
const is_number = require('is-number');
const _ = require('lodash');
const minimist = require('minimist');
const https = require('https');
const http = require('http');
const { hdb_errors } = require('./errors/hdbError');

const ISO_DATE =
	/^((\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z)))$/;

const async_set_timeout = require('util').promisify(setTimeout);
const HDB_PROC_START_TIMEOUT = 100;
const CHECK_PROCS_LOOP_LIMIT = 5;

const EMPTY_STRING = '';
const FILE_EXTENSION_LENGTH = 4;
const CHARACTER_LIMIT = 255;

//Because undefined will not return in a JSON response, we convert undefined to null when autocasting
const AUTOCAST_COMMON_STRINGS = {
	true: true,
	TRUE: true,
	FALSE: false,
	false: false,
	undefined: null,
	null: null,
	NULL: null,
	NaN: NaN,
};
module.exports = {
	isEmpty: isEmpty,
	isEmptyOrZeroLength: isEmptyOrZeroLength,
	arrayHasEmptyValues: arrayHasEmptyValues,
	arrayHasEmptyOrZeroLengthValues: arrayHasEmptyOrZeroLengthValues,
	buildFolderPath: buildFolderPath,
	isBoolean: isBoolean,
	errorizeMessage: errorizeMessage,
	stripFileExtension: stripFileExtension,
	autoCast,
	autoCastJSON,
	autoCastJSONDeep,
	removeDir: removeDir,
	compareVersions,
	isCompatibleDataVersion,
	escapeRawValue: escapeRawValue,
	unescapeValue: unescapeValue,
	stringifyProps: stringifyProps,
	timeoutPromise: timeoutPromise,
	isClusterOperation: isClusterOperation,
	getClusterUser: getClusterUser,
	checkGlobalSchemaTable,
	getHomeDir: getHomeDir,
	getPropsFilePath: getPropsFilePath,
	promisifyPapaParse,
	removeBOM,
	createEventPromise,
	checkProcessRunning,
	checkSchemaTableExist,
	checkSchemaExists,
	checkTableExists,
	getStartOfTomorrowInSeconds,
	getLimitKey,
	isObject,
	isNotEmptyAndHasValue,
	autoCasterIsNumberCheck,
	backtickASTSchemaItems,
	isPortTaken,
	createForkArgs,
	autoCastBoolean,
	async_set_timeout,
	getTableHashAttribute,
	doesSchemaExist,
	doesTableExist,
	stringifyObj,
	ms_to_time,
	changeExtension,
	getEnvCliRootPath,
	noBootFile,
	httpRequest,
	transformReq,
	convertToMS,
	PACKAGE_ROOT: terms.PACKAGE_ROOT,
};

/**
 * Converts a message to an error containing the error as a message. Will always return an error if the passed in error is
 * not a message.
 * @param message
 * @returns {*}
 */
function errorizeMessage(message) {
	if (!(message instanceof Error)) {
		return new Error(message);
	}
	return message;
}

/**
 * Test if the passed value is null or undefined.  This will not check string length.
 * @param value - the value to test
 * @returns {boolean}
 */
function isEmpty(value) {
	return value === undefined || value === null;
}

function isNotEmptyAndHasValue(value) {
	return !isEmpty(value) && (value || value === 0 || value === '' || isBoolean(value));
}

/**
 * Test if the passed value is null, undefined, or zero length or size.
 * @param value - the value to test
 * @returns {boolean}
 */
function isEmptyOrZeroLength(value) {
	return isEmpty(value) || value.length === 0 || value.size === 0;
}

/**
 * Test if the passed array contains any null or undefined values.
 * @param values_list - An array of values
 * @returns {boolean}
 */
function arrayHasEmptyValues(values_list) {
	if (isEmpty(values_list)) {
		return true;
	}
	for (let val = 0; val < values_list.length; val++) {
		if (isEmpty(values_list[val])) {
			return true;
		}
	}
	return false;
}

/**
 * Test if the passed array contains any null or undefined values.
 * @param values_list - An array of values
 * @returns {boolean}
 */
function arrayHasEmptyOrZeroLengthValues(values_list) {
	if (isEmptyOrZeroLength(values_list)) {
		return true;
	}
	for (let val = 0; val < values_list.length; val++) {
		if (isEmptyOrZeroLength(values_list[val])) {
			return true;
		}
	}
	return false;
}

/**
 * takes an array of strings and joins them with the folder separator to return a path
 * @param path_elements
 */
function buildFolderPath(...path_elements) {
	try {
		return path_elements.join(path.sep);
	} catch (e) {
		console.error(path_elements);
	}
}

/**
 * takes a value and checks if it is a boolean value (true/false)
 * @param value
 * @returns {boolean}
 */
function isBoolean(value) {
	if (isEmpty(value)) {
		return false;
	}

	return value === true || value === false;
}

/**
 * Takes a value and checks if it is an object.
 * Note - null is considered an object but we are excluding it here.
 * @param value
 * @returns {boolean}
 */
function isObject(value) {
	if (isEmpty(value)) {
		return false;
	}

	return typeof value === 'object';
}

/**
 * Strip the .hdb file extension from file names.  To keep this efficient, this will not check that the
 * parameter contains the .hdb extension.
 * @param file_name - the filename.
 * @returns {string}
 */
function stripFileExtension(file_name) {
	if (isEmptyOrZeroLength(file_name)) {
		return EMPTY_STRING;
	}
	return file_name.slice(0, -FILE_EXTENSION_LENGTH);
}

/**
 * Takes a raw string value and casts it to the correct data type, including Object & Array, but not Dates
 * @param data
 * @returns
 */
function autoCast(data) {
	if (isEmpty(data) || data === '') {
		return data;
	}

	//if this is already typed other than string, return data
	if (typeof data !== 'string') {
		return data;
	}

	// Try to make it a common string
	if (AUTOCAST_COMMON_STRINGS[data] !== undefined) {
		return AUTOCAST_COMMON_STRINGS[data];
	}

	if (autoCasterIsNumberCheck(data) === true) {
		return Number(data);
	}

	if (ISO_DATE.test(data)) return new Date(data);

	return data;
}

function autoCastJSON(data) {
	//in order to handle json and arrays we test the string to see if it seems minimally like an object or array and perform a JSON.parse on it.
	//if it fails we assume it is just a regular string
	if (
		typeof data === 'string' &&
		((data.startsWith('{') && data.endsWith('}')) || (data.startsWith('[') && data.endsWith(']')))
	) {
		try {
			return JSON.parse(data);
		} catch (e) {
			//no-op
		}
	}
	return data;
}
function autoCastJSONDeep(data) {
	if (data && typeof data === 'object') {
		if (Array.isArray(data)) {
			for (let i = 0, l = data.length; i < l; i++) {
				let element = data[i];
				let casted = autoCastJSONDeep(element);
				if (casted !== element) data[i] = casted;
			}
		} else {
			for (let i in data) {
				let element = data[i];
				let casted = autoCastJSONDeep(element);
				if (casted !== element) data[i] = casted;
			}
		}
		return data;
	} else return autoCastJSON(data);
}

/**
 * function to check if a string is a number based on the rules used by our autocaster
 * @param {string} data
 * @returns {boolean}
 */
function autoCasterIsNumberCheck(data) {
	if (data.startsWith('0.') && is_number(data)) {
		return true;
	}

	let contains_e = data.toUpperCase().includes('E');
	let starts_with_zero = data !== '0' && data.startsWith('0');
	return !!(starts_with_zero === false && contains_e === false && is_number(data));
}

/**
 * Removes all files in a given directory path.
 * @param dir_path
 * @returns {Promise<[any]>}
 */
async function removeDir(dir_path) {
	if (isEmptyOrZeroLength(dir_path)) {
		throw new Error(`Directory path: ${dir_path} does not exist`);
	}
	try {
		await fs_extra.emptyDir(dir_path);
		await fs_extra.remove(dir_path);
	} catch (e) {
		log.error(`Error removing files in ${dir_path} -- ${e}`);
		throw e;
	}
}

/**
 * Sorting function, Get old_version list of version directives to run during an upgrade.
 * Can be used via [<versions>].sort(compareVersions). Can also be used to just compare strictly version
 * numbers.  Returns a number less than 0 if the old_version is less than new_version.
 * e.x. compareVersionsompareVersions('1.1.0', '2.0.0') will return a value less than 0.
 * @param old_version - As an UpgradeDirective object or just a version number as a string
 * @param new_version - Newest version As an UpgradeDirective object or just a version number as a string
 * @returns {*}
 */
function compareVersions(old_version, new_version) {
	if (isEmptyOrZeroLength(old_version)) {
		log.info('Invalid current version sent as parameter.');
		return;
	}
	if (isEmptyOrZeroLength(new_version)) {
		log.info('Invalid upgrade version sent as parameter.');
		return;
	}
	let diff;
	let regExStrip0 = /(\.0+)+$/;
	let old_version_as_string = old_version.version ? old_version.version : old_version;
	let new_version_as_string = new_version.version ? new_version.version : new_version;
	let segmentsA = old_version_as_string.replace(regExStrip0, '').split('.');
	let segmentsB = new_version_as_string.replace(regExStrip0, '').split('.');
	let l = Math.min(segmentsA.length, segmentsB.length);

	for (let i = 0; i < l; i++) {
		diff = parseInt(segmentsA[i], 10) - parseInt(segmentsB[i], 10);
		if (diff) {
			return diff;
		}
	}
	return segmentsA.length - segmentsB.length;
}

/**
 * Check to see if the data from one version is compatible with another. Per semver, this is only major version changes
 * @param old_version
 * @param new_version
 * @returns {boolean}
 */
function isCompatibleDataVersion(old_version, new_version, check_minor = false) {
	let old_parts = old_version.toString().split('.');
	let new_parts = new_version.toString().split('.');
	return old_parts[0] === new_parts[0] && (!check_minor || old_parts[1] === new_parts[1]);
}

/**
 * takes a raw value and replaces any forward slashes with the unicode equivalent.  if the value directly matches "." or ".." then it replaces with their unicode equivalent
 * the reason for this is to because linux does not allow forward slashes in folder names and "." & ".." are already taken
 * @param value
 * @returns {string}
 */
function escapeRawValue(value) {
	if (isEmpty(value)) {
		return value;
	}
	let the_value = String(value);

	if (the_value === '.') {
		return terms.UNICODE_PERIOD;
	}

	if (the_value === '..') {
		return terms.UNICODE_PERIOD + terms.UNICODE_PERIOD;
	}

	return the_value.replace(terms.FORWARD_SLASH_REGEX, terms.UNICODE_FORWARD_SLASH);
}

/**
 * takes the value and unesacapes the unicode for any occurrance of "U+002F" and exact values of  "U+002E", "U+002EU+002E"
 * @param value
 * @returns {string}
 */
function unescapeValue(value) {
	if (isEmpty(value)) {
		return value;
	}

	let the_value = String(value);

	if (the_value === terms.UNICODE_PERIOD) {
		return '.';
	}

	if (the_value === terms.UNICODE_PERIOD + terms.UNICODE_PERIOD) {
		return '..';
	}

	return String(value).replace(terms.ESCAPED_FORWARD_SLASH_REGEX, '/');
}

/**
 * Takes a PropertiesReader object and converts it to a string so it can be printed to a file.
 * @param prop_reader_object - An object of type properties-reader containing properties stored in settings.js
 * @param comments - Object with key,value describing comments that should be placed above a variable in the settings file.
 * The key is the variable name (PROJECT_DIR) and the value will be the string comment.
 * @returns {string}
 */
function stringifyProps(prop_reader_object, comments) {
	if (isEmpty(prop_reader_object)) {
		log.info('Properties object is null');
		return '';
	}
	let lines = '';
	prop_reader_object.each(function (key, value) {
		try {
			if (comments && comments[key]) {
				let curr_comments = comments[key];
				for (let comm of curr_comments) {
					lines += ';' + comm + os.EOL;
				}
			}
			if (!isEmptyOrZeroLength(key) && key[0] === ';') {
				// This is a comment, just write it all
				lines += '\t' + key + value + os.EOL;
			} else if (!isEmptyOrZeroLength(key)) {
				lines += key + '=' + value + os.EOL;
			}
		} catch (e) {
			log.error(`Found bad property during upgrade with key ${key} and value: ${value}`);
		}
	});
	return lines;
}

function getHomeDir() {
	let home_dir = undefined;
	try {
		home_dir = os.homedir();
	} catch (err) {
		// could get here in android
		home_dir = process.env.HOME;
	}
	return home_dir;
}

/**
 * This function will attempt to find the hdb_boot_properties.file path.  IT IS SYNCHRONOUS, SO SHOULD ONLY BE
 * CALLED IN CERTAIN SITUATIONS (startup, upgrade, etc).
 */
function getPropsFilePath() {
	let boot_props_file_path = path.join(getHomeDir(), terms.HDB_HOME_DIR_NAME, terms.BOOT_PROPS_FILE_NAME);
	// this checks how we used to store the boot props file for older installations.
	if (!fs.existsSync(boot_props_file_path)) {
		boot_props_file_path = path.join(__dirname, '../', 'hdb_boot_properties.file');
	}
	return boot_props_file_path;
}

/**
 * Creates a promisified timeout that exposes a cancel() function in case the timeout needs to be cancelled.
 * @param ms
 * @param msg - The message to resolve the promise with should it timeout
 * @returns {{promise: (Promise|Promise<any>), cancel: cancel}}
 */
function timeoutPromise(ms, msg) {
	let timeout, promise;

	promise = new Promise(function (resolve) {
		timeout = setTimeout(function () {
			resolve(msg);
		}, ms);
	});

	return {
		promise: promise,
		cancel: function () {
			clearTimeout(timeout);
		},
	};
}

/**
 * Checks to see if a port is taken or not.
 * @param port
 * @returns {Promise<unknown>}
 */
async function isPortTaken(port) {
	if (!port) {
		throw new Error(`Invalid port passed as parameter`);
	}

	// To check if a port is taken or not we create a tester server at the provided port.
	return new Promise((resolve, reject) => {
		const tester = net
			.createServer()
			.once('error', (err) => {
				err.code === 'EADDRINUSE' ? resolve(true) : reject(err);
			})
			.once('listening', () => tester.once('close', () => resolve(false)).close())
			.listen(port);
	});
}

/**
 * Returns true if a given operation name is a cluster operation.  Should always return a boolean.
 * @param operation_name - the operation name being called
 * @returns {boolean|*}
 */
function isClusterOperation(operation_name) {
	try {
		return terms.CLUSTER_OPERATIONS[operation_name.toLowerCase()] !== undefined;
	} catch (err) {
		log.error(`Error checking operation against cluster ops ${err}`);
	}
	return false;
}

/**
 * Checks the global databases for a schema and table
 * @param schema_name
 * @param table_name
 * @returns string returns a thrown message if schema and or table does not exist
 */
function checkGlobalSchemaTable(schema_name, table_name) {
	let databases = require('../resources/databases').getDatabases();
	if (!databases[schema_name]) {
		return hdb_errors.HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(schema_name);
	}
	if (!databases[schema_name][table_name]) {
		return hdb_errors.HDB_ERROR_MSGS.TABLE_NOT_FOUND(schema_name, table_name);
	}
}

function getClusterUser(users, cluster_user_name) {
	if (isEmpty(cluster_user_name)) {
		log.warn('No CLUSTERING_USER defined, clustering disabled');
		return;
	}

	if (isEmpty(users) || isEmptyOrZeroLength(users)) {
		log.warn('No users to search.');
		return;
	}

	let cluster_user;

	try {
		const temp_cluster_user = users.get(cluster_user_name);

		if (
			temp_cluster_user &&
			temp_cluster_user.role.permission.cluster_user === true &&
			temp_cluster_user.active === true
		) {
			cluster_user = temp_cluster_user;
		}
	} catch (e) {
		log.error(`unable to find cluster_user due to: ${e.message}`);
		return;
	}

	if (cluster_user === undefined) {
		log.warn(`CLUSTERING_USER: ${cluster_user_name} not found or is not active.`);
		return;
	}

	return cluster_user;
}

/**
 * Promisify csv parser papaparse. Once function is promisified it can be called with:
 * papa_parse.parsePromise(<reject-promise-obj>, <read-stream>, <chunking-function>)
 * In the case of an error, reject promise object must be called from chunking-function, it will bubble up
 * through bind to this function.
 */
function promisifyPapaParse() {
	papa_parse.parsePromise = function (stream, chunk_func, typing_function) {
		return new Promise(function (resolve, reject) {
			papa_parse.parse(stream, {
				header: true,
				transformHeader: removeBOM,
				chunk: chunk_func.bind(null, reject),
				skipEmptyLines: true,
				transform: typing_function,
				dynamicTyping: false,
				error: reject,
				complete: resolve,
			});
		});
	};
}

/**
 * Removes the byte order mark from a string
 * @returns a string minus any byte order marks
 * @param data_string
 */
function removeBOM(data_string) {
	if (typeof data_string !== 'string') {
		throw new TypeError(`Expected a string, got ${typeof data_string}`);
	}

	if (data_string.charCodeAt(0) === 0xfeff) {
		return data_string.slice(1);
	}

	return data_string;
}

function createEventPromise(event_name, event_emitter_object, timeout_promise) {
	return new Promise((resolve) => {
		event_emitter_object.once(event_name, (msg) => {
			let curr_timeout_promise = timeout_promise;
			log.info(`Got cluster status event response: ${inspect(msg)}`);
			try {
				curr_timeout_promise.cancel();
			} catch (err) {
				log.error('Error trying to cancel timeout.');
			}
			resolve(msg);
		});
	});
}

/**
 * Verifies the named process has started before fulfilling promise.
 * @returns {Promise<void>}
 */
async function checkProcessRunning(proc_name) {
	let go_on = true;
	let x = 0;
	do {
		await async_set_timeout(HDB_PROC_START_TIMEOUT * x++);

		let instances = await ps_list.findPs(proc_name);

		if (instances.length > 0) {
			go_on = false;
		}
	} while (go_on && x < CHECK_PROCS_LOOP_LIMIT);

	if (go_on) {
		throw new Error(`process ${proc_name} was not started`);
	}
}

/**
 * Checks the global schema to see if a Schema or Table exist.
 * @param schema
 * @param table
 */
function checkSchemaTableExist(schema, table) {
	let schema_not_exist = checkSchemaExists(schema);
	if (schema_not_exist) {
		return schema_not_exist;
	}

	let table_not_exist = checkTableExists(schema, table);
	if (table_not_exist) {
		return table_not_exist;
	}
}

/**
 * Checks the global schema to see if a schema exist.
 * @param schema
 * @returns {string}
 */
function checkSchemaExists(schema) {
	const { getDatabases } = require('../resources/databases');
	if (!getDatabases()[schema]) {
		return hdb_errors.HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(schema);
	}
}

/**
 * Checks the global schema to see if a table exist.
 * @param schema
 * @param table
 * @returns {string}
 */
function checkTableExists(schema, table) {
	const { getDatabases } = require('../resources/databases');
	if (!getDatabases()[schema][table]) {
		return hdb_errors.HDB_ERROR_MSGS.TABLE_NOT_FOUND(schema, table);
	}
}

/**
 * Returns the first second of the next day in seconds.
 * @returns {number}
 */
function getStartOfTomorrowInSeconds() {
	let tomorow_seconds = moment().utc().add(1, 'd').startOf('d').unix();
	let now_seconds = moment().utc().unix();
	return tomorow_seconds - now_seconds;
}

/**
 * Returns the key used by limits for this cycle.
 * @returns {string}
 */
function getLimitKey() {
	return moment().utc().format('DD-MM-YYYY');
}

/**
 * Automatically adds backticks "`" to all schema elements found in an AST - the reason for this is in SQL you can surround
 * a reserved word with backticks as an escape to allow a schema element which is named the same as a reserved word to be used.
 * The issue is once alasql parses the sql the backticks are removed and we need them when we execute the final SQL.
 */
function backtickASTSchemaItems(statement) {
	try {
		let iterator = new RecursiveIterator(statement);
		for (let { node } of iterator) {
			if (node) {
				if (node.columnid && typeof node.columnid !== 'string') {
					node.columnid = node.columnid.toString();
				}
				if (node.columnid && !node.columnid.startsWith('`')) {
					node.columnid_orig = node.columnid;
					node.columnid = `\`${node.columnid}\``;
				}
				if (node.tableid && !node.tableid.startsWith('`')) {
					node.tableid_orig = node.tableid;
					node.tableid = `\`${node.tableid}\``;
				}
				if (node.databaseid && !node.databaseid.startsWith('`')) {
					node.databaseid_orig = node.databaseid;
					node.databaseid = `\`${node.databaseid}\``;
				}

				if (node.as && typeof node.as === 'string' && !node.as.startsWith('[')) {
					node.as_orig = node.as;
					node.as = `\`${node.as}\``;
				}
			}
		}
	} catch (err) {
		log.error(`Got an error back ticking items.`);
		log.error(err);
	}
}

/**
 * Create arguments for child_process fork
 * @param module_path
 * @returns {*[]}
 */
function createForkArgs(module_path) {
	return [module_path];
}

/**
 * Takes a boolean string/value and casts it to a boolean
 * @param boolean
 * @returns {boolean}
 */
function autoCastBoolean(boolean) {
	return boolean === true || (typeof boolean === 'string' && boolean.toLowerCase() === 'true');
}

/**
 * Gets a tables hash attribute from the global schema
 */
function getTableHashAttribute(schema, table) {
	const { getDatabases } = require('../resources/databases');
	let table_obj = getDatabases()[schema]?.[table];
	return table_obj?.primaryKey || table_obj?.hash_attribute;
}

/**
 * Checks the global schema to see if schema exists
 * @param schema
 * @returns {boolean} - returns true if schema exists
 */
function doesSchemaExist(schema) {
	const { getDatabases } = require('../resources/databases');
	return getDatabases()[schema] !== undefined;
}

/**
 * Checks the global schema to see if schema exists
 * @param schema
 * @param table
 * @returns {boolean} - returns true if table exists
 */
function doesTableExist(schema, table) {
	const { getDatabases } = require('../resources/databases');
	return getDatabases()[schema]?.[table] !== undefined;
}

/**
 * Tries to stringify an object, if it cant just return that value unchanged.
 * @param value
 * @returns {any}
 */
function stringifyObj(value) {
	try {
		return JSON.stringify(value);
	} catch (err) {
		return value;
	}
}

/**
 * Converts milliseconds to a readable time, e.g. 2d 3h 12m 1s
 * @param ms
 * @returns {*}
 */
function ms_to_time(ms) {
	const duration = moment.duration(ms);
	const sec = duration.seconds() > 0 ? duration.seconds() + 's' : '';
	const min = duration.minutes() > 0 ? duration.minutes() + 'm ' : '';
	const hrs = duration.hours() > 0 ? duration.hours() + 'h ' : '';
	const day = duration.days() > 0 ? duration.days() + 'd ' : '';
	const year = duration.years() > 0 ? duration.years() + 'y ' : '';

	return year + day + hrs + min + sec;
}

/**
 * Change the extension of a file.
 * @param file
 * @param extension
 * @returns {string}
 */
function changeExtension(file, extension) {
	const basename = path.basename(file, path.extname(file));
	return path.join(path.dirname(file), basename + extension);
}

/**
 * Checks ENV and CLI for ROOTPATH arg
 */
function getEnvCliRootPath() {
	if (process.env[terms.CONFIG_PARAMS.ROOTPATH.toUpperCase()])
		return process.env[terms.CONFIG_PARAMS.ROOTPATH.toUpperCase()];
	const cli_args = minimist(process.argv);
	if (cli_args[terms.CONFIG_PARAMS.ROOTPATH.toUpperCase()]) return cli_args[terms.CONFIG_PARAMS.ROOTPATH.toUpperCase()];
}

/**
 * Will check to see if there is a rootpath cli/env var pointing to a harperdb-config.yaml file
 * This is used for running HDB without a boot file
 */
let no_boot_file;
function noBootFile() {
	if (no_boot_file) return no_boot_file;
	const cli_env_root = getEnvCliRootPath();
	if (getEnvCliRootPath() && fs.pathExistsSync(path.join(cli_env_root, terms.HDB_CONFIG_FILE))) {
		no_boot_file = true;
		return true;
	}
}

function httpRequest(options, data) {
	let client;
	if (options.protocol === 'http:') client = http;
	else client = https;
	return new Promise((resolve, reject) => {
		const req = client.request(options, (response) => {
			response.setEncoding('utf8');
			response.body = '';
			response.on('data', (chunk) => {
				response.body += chunk;
			});

			response.on('end', () => {
				resolve(response);
			});
		});

		req.on('error', (err) => {
			reject(err);
		});

		req.write(data instanceof Buffer ? data : JSON.stringify(data));
		req.end();
	});
}

/**
 * Will set default schema/database or set database to schema
 * @param req
 */
function transformReq(req) {
	if (!req.schema && !req.database) {
		req.schema = terms.DEFAULT_DATABASE_NAME;
		return;
	}
	if (req.database) req.schema = req.database;
}

function convertToMS(interval) {
	let seconds = 0;
	if (typeof interval === 'number') seconds = interval;
	if (typeof interval === 'string') {
		seconds = parseFloat(interval);
		switch (interval.slice(-1)) {
			case 'M':
				seconds *= 86400 * 30;
				break;
			case 'D':
			case 'd':
				seconds *= 86400;
				break;
			case 'H':
			case 'h':
				seconds *= 3600;
				break;
			case 'm':
				seconds *= 60;
				break;
		}
	}
	return seconds * 1000;
}
