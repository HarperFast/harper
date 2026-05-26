'use strict';
import * as path from 'path';
import * as fs from 'fs-extra';
import log from './logging/harper_logger.ts';
import * as fsExtra from 'fs-extra';
import * as os from 'os';
import * as net from 'net';
import RecursiveIterator from 'recursive-iterator';
import * as terms from './hdbTerms.ts';
import { PACKAGE_ROOT } from './packageUtils.js';
export { PACKAGE_ROOT };
import * as papaParse from 'papaparse';
import moment from 'moment';
import isNumber from 'is-number';
import minimist from 'minimist';
import * as https from 'https';
import * as http from 'http';

const ISO_DATE =
	/^((\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z)))$/;

import * as util from 'util';
export const asyncSetTimeout = util.promisify(setTimeout);

const EMPTY_STRING = '';
const FILE_EXTENSION_LENGTH = 4;

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

/**
 * Converts a message to an error containing the error as a message. Will always return an error if the passed in error is
 * not a message.
 * @param message
 * @returns {*}
 */
export function errorizeMessage(message: any) {
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
export function isEmpty(value: any) {
	return value === undefined || value === null;
}

export function isNotEmptyAndHasValue(value: any) {
	return !isEmpty(value) && (value || value === 0 || value === '' || isBoolean(value));
}

/**
 * Test if the passed value is null, undefined, or zero length or size.
 * @param value - the value to test
 * @returns {boolean}
 */
export function isEmptyOrZeroLength(value: any) {
	return isEmpty(value) || value.length === 0 || value.size === 0;
}

/**
 * Test if the passed array contains any null or undefined values.
 * @param valuesList - An array of values
 * @returns {boolean}
 */
export function arrayHasEmptyValues(valuesList: any) {
	if (isEmpty(valuesList)) {
		return true;
	}
	for (let val = 0; val < valuesList.length; val++) {
		if (isEmpty(valuesList[val])) {
			return true;
		}
	}
	return false;
}

/**
 * Test if the passed array contains any null or undefined values.
 * @param valuesList - An array of values
 * @returns {boolean}
 */
export function arrayHasEmptyOrZeroLengthValues(valuesList: any) {
	if (isEmptyOrZeroLength(valuesList)) {
		return true;
	}
	for (let val = 0; val < valuesList.length; val++) {
		if (isEmptyOrZeroLength(valuesList[val])) {
			return true;
		}
	}
	return false;
}

/**
 * takes an array of strings and joins them with the folder separator to return a path
 * @param pathElements
 */
export function buildFolderPath(...pathElements: any[]) {
	try {
		return pathElements.join(path.sep);
	} catch {
		console.error(pathElements);
	}
}

/**
 * takes a value and checks if it is a boolean value (true/false)
 * @param value
 * @returns {boolean}
 */
export function isBoolean(value: any) {
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
export function isObject(value: any) {
	if (isEmpty(value)) {
		return false;
	}

	return typeof value === 'object';
}

/**
 * Strip the .hdb file extension from file names.  To keep this efficient, this will not check that the
 * parameter contains the .hdb extension.
 * @param fileName - the filename.
 * @returns {string}
 */
export function stripFileExtension(fileName: any) {
	if (isEmptyOrZeroLength(fileName)) {
		return EMPTY_STRING;
	}
	return fileName.slice(0, -FILE_EXTENSION_LENGTH);
}

/**
 * Takes a raw string value and casts it to the correct data type, including Object & Array, but not Dates
 * @param data
 * @returns
 */
export function autoCast(data: any) {
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

export function autoCastJSON(data: any) {
	//in order to handle json and arrays we test the string to see if it seems minimally like an object or array and perform a JSON.parse on it.
	//if it fails we assume it is just a regular string
	if (
		typeof data === 'string' &&
		((data.startsWith('{') && data.endsWith('}')) || (data.startsWith('[') && data.endsWith(']')))
	) {
		try {
			return JSON.parse(data);
		} catch {
			//no-op
		}
	}
	return data;
}
export function autoCastJSONDeep(data: any) {
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
export function autoCasterIsNumberCheck(data: any) {
	if (data.startsWith('0.') && isNumber(data)) {
		return true;
	}

	let containsE = data.toUpperCase().includes('E');
	let startsWithZero = data !== '0' && data.startsWith('0');
	return !!(startsWithZero === false && containsE === false && isNumber(data));
}

/**
 * Removes all files in a given directory path.
 * @param dirPath
 * @returns {Promise<[any]>}
 */
export async function removeDir(dirPath: string) {
	if (isEmptyOrZeroLength(dirPath)) {
		throw new Error(`Directory path: ${dirPath} does not exist`);
	}
	try {
		await fsExtra.emptyDir(dirPath);
		await fsExtra.remove(dirPath);
	} catch (e) {
		log.error(`Error removing files in ${dirPath} -- ${e}`);
		throw e;
	}
}

/**
 * Sorting function, Get oldVersion list of version directives to run during an upgrade.
 * Can be used via [<versions>].sort(compareVersions). Can also be used to just compare strictly version
 * numbers.  Returns a number less than 0 if the oldVersion is less than newVersion.
 * e.x. compareVersionsompareVersions('1.1.0', '2.0.0') will return a value less than 0.
 * @param oldVersion - As an UpgradeDirective object or just a version number as a string
 * @param newVersion - Newest version As an UpgradeDirective object or just a version number as a string
 * @returns {*}
 */
export function compareVersions(oldVersion: any, newVersion: any) {
	if (isEmptyOrZeroLength(oldVersion)) {
		log.info('Invalid current version sent as parameter.');
		return;
	}
	if (isEmptyOrZeroLength(newVersion)) {
		log.info('Invalid upgrade version sent as parameter.');
		return;
	}
	let diff;
	let regExStrip0 = /(\.0+)+$/;
	let oldVersionAsString = oldVersion.version ? oldVersion.version : oldVersion;
	let newVersionAsString = newVersion.version ? newVersion.version : newVersion;
	let segmentsA = oldVersionAsString.replace(regExStrip0, '').split('.');
	let segmentsB = newVersionAsString.replace(regExStrip0, '').split('.');
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
 * @param oldVersion
 * @param newVersion
 * @returns {boolean}
 */
export function isCompatibleDataVersion(oldVersion: any, newVersion: any, checkMinor = false) {
	let oldParts = oldVersion.toString().split('.');
	let newParts = newVersion.toString().split('.');
	return oldParts[0] === newParts[0] && (!checkMinor || oldParts[1] === newParts[1]);
}

/**
 * takes a raw value and replaces any forward slashes with the unicode equivalent.  if the value directly matches "." or ".." then it replaces with their unicode equivalent
 * the reason for this is to because linux does not allow forward slashes in folder names and "." & ".." are already taken
 * @param value
 * @returns {string}
 */
export function escapeRawValue(value: any) {
	if (isEmpty(value)) {
		return value;
	}
	let theValue = String(value);

	if (theValue === '.') {
		return terms.UNICODE_PERIOD;
	}

	if (theValue === '..') {
		return terms.UNICODE_PERIOD + terms.UNICODE_PERIOD;
	}

	return theValue.replace(terms.FORWARD_SLASH_REGEX, terms.UNICODE_FORWARD_SLASH);
}

/**
 * takes the value and unesacapes the unicode for any occurrance of "U+002F" and exact values of  "U+002E", "U+002EU+002E"
 * @param value
 * @returns {string}
 */
export function unescapeValue(value: any) {
	if (isEmpty(value)) {
		return value;
	}

	let theValue = String(value);

	if (theValue === terms.UNICODE_PERIOD) {
		return '.';
	}

	if (theValue === terms.UNICODE_PERIOD + terms.UNICODE_PERIOD) {
		return '..';
	}

	return String(value).replace(terms.ESCAPED_FORWARD_SLASH_REGEX, '/');
}

/**
 * Takes a PropertiesReader object and converts it to a string so it can be printed to a file.
 * @param propReaderObject - An object of type properties-reader containing properties stored in settings.js
 * @param comments - Object with key,value describing comments that should be placed above a variable in the settings file.
 * The key is the variable name (PROJECT_DIR) and the value will be the string comment.
 * @returns {string}
 */
export function stringifyProps(propReaderObject: any, comments?: any) {
	if (isEmpty(propReaderObject)) {
		log.info('Properties object is null');
		return '';
	}
	let lines = '';
	propReaderObject.each(function (key, value) {
		try {
			if (comments && comments[key]) {
				let currComments = comments[key];
				for (let comm of currComments) {
					lines += ';' + comm + os.EOL;
				}
			}
			if (!isEmptyOrZeroLength(key) && key[0] === ';') {
				// This is a comment, just write it all
				lines += '\t' + key + value + os.EOL;
			} else if (!isEmptyOrZeroLength(key)) {
				lines += key + '=' + value + os.EOL;
			}
		} catch {
			log.error(`Found bad property during upgrade with key ${key} and value: ${value}`);
		}
	});
	return lines;
}

export function getHomeDir() {
	let homeDir = undefined;
	try {
		homeDir = os.homedir();
	} catch {
		// could get here in android
		homeDir = process.env.HOME;
	}
	return homeDir;
}

/**
 * This function will attempt to find the hdbBootProperties.file path.  IT IS SYNCHRONOUS, SO SHOULD ONLY BE
 * CALLED IN CERTAIN SITUATIONS (startup, upgrade, etc).
 */
export function getPropsFilePath() {
	let bootPropsFilePath = path.join(getHomeDir(), terms.HDB_HOME_DIR_NAME, terms.BOOT_PROPS_FILE_NAME);
	// this checks how we used to store the boot props file for older installations.
	if (!fs.existsSync(bootPropsFilePath)) {
		bootPropsFilePath = path.join(PACKAGE_ROOT, 'hdb_boot_properties.file');
	}
	return bootPropsFilePath;
}

/**
 * Creates a promisified timeout that exposes a cancel() function in case the timeout needs to be cancelled.
 * @param ms
 * @param msg - The message to resolve the promise with should it timeout
 * @returns {{promise: (Promise|Promise<any>), cancel: cancel}}
 */
export function timeoutPromise(ms: number, msg?: any) {
	let timeout, promise;

	promise = new Promise(function (resolve) {
		timeout = setTimeout(function () {
			resolve(msg);
		}, ms);
	});

	return {
		promise,
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
export async function isPortTaken(port: number) {
	if (!port) {
		throw new Error(`Invalid port passed as parameter`);
	}

	// To check if a port is taken or not we create a tester server at the provided port.
	return new Promise((resolve, reject) => {
		const tester = net
			.createServer()
			.once('error', (err) => {
				(err as any).code === 'EADDRINUSE' ? resolve(true) : reject(err);
			})
			.once('listening', () => tester.once('close', () => resolve(false)).close())
			.listen(port);
	});
}

/**
 * Checks the global databases for a schema and table
 * @param schemaName
 * @param tableName
 * @returns string returns a thrown message if schema and or table does not exist
 */
export function checkGlobalSchemaTable(schemaName: string, tableName: string) {
	let databases = require('../resources/databases').getDatabases();
	if (!databases[schemaName]) {
		return hdbErrors.HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(schemaName);
	}
	if (!databases[schemaName][tableName]) {
		return hdbErrors.HDB_ERROR_MSGS.TABLE_NOT_FOUND(schemaName, tableName);
	}
}

/**
 * Promisify csv parser papaparse. Once function is promisified it can be called with:
 * papaParse.parsePromise(<reject-promise-obj>, <read-stream>, <chunking-function>)
 * In the case of an error, reject promise object must be called from chunking-function, it will bubble up
 * through bind to this function.
 */
export function parsePromise(stream: any, chunkFunc: any, typingFunction: any): Promise<any> {
	return new Promise(function (resolve, reject) {
		papaParse.parse(stream, {
			header: true,
			transformHeader: removeBOM,
			chunk: chunkFunc.bind(null, reject),
			skipEmptyLines: true,
			transform: typingFunction,
			dynamicTyping: false,
			error: reject,
			complete: resolve,
		});
	});
}

/**
 * Removes the byte order mark from a string
 * @returns a string minus any byte order marks
 * @param dataString
 */
export function removeBOM(dataString: any) {
	if (typeof dataString !== 'string') {
		throw new TypeError(`Expected a string, got ${typeof dataString}`);
	}

	if (dataString.charCodeAt(0) === 0xfeff) {
		return dataString.slice(1);
	}

	return dataString;
}

export function createEventPromise(eventName: string, eventEmitterObject: any, timeout_promise?: any) {
	return new Promise((resolve) => {
		eventEmitterObject.once(eventName, (msg) => {
			let currTimeoutPromise = timeout_promise;
			try {
				currTimeoutPromise.cancel();
			} catch {
				log.error('Error trying to cancel timeout.');
			}
			resolve(msg);
		});
	});
}

/**
 * Checks the global schema to see if a Schema or Table exist.
 * @param schema
 * @param table
 */
export function checkSchemaTableExist(schema: string, table: string) {
	let schemaNotExist = checkSchemaExists(schema);
	if (schemaNotExist) {
		return schemaNotExist;
	}

	let tableNotExist = checkTableExists(schema, table);
	if (tableNotExist) {
		return tableNotExist;
	}
}

/**
 * Checks the global schema to see if a schema exist.
 * @param schema
 * @returns {string}
 */
export function checkSchemaExists(schema: string) {
	const { getDatabases } = require('../resources/databases');
	if (!getDatabases()[schema]) {
		return hdbErrors.HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(schema);
	}
}

/**
 * Checks the global schema to see if a table exist.
 * @param schema
 * @param table
 * @returns {string}
 */
export function checkTableExists(schema: string, table: string) {
	const { getDatabases } = require('../resources/databases');
	if (!getDatabases()[schema][table]) {
		return hdbErrors.HDB_ERROR_MSGS.TABLE_NOT_FOUND(schema, table);
	}
}

/**
 * Returns the first second of the next day in seconds.
 * @returns {number}
 */
export function getStartOfTomorrowInSeconds() {
	let tomorowSeconds = moment().utc().add(1, 'd').startOf('d').unix();
	let nowSeconds = moment().utc().unix();
	return tomorowSeconds - nowSeconds;
}

/**
 * Returns the key used by limits for this cycle.
 * @returns {string}
 */
export function getLimitKey() {
	return moment().utc().format('DD-MM-YYYY');
}

/**
 * Automatically adds backticks "`" to all schema elements found in an AST - the reason for this is in SQL you can surround
 * a reserved word with backticks as an escape to allow a schema element which is named the same as a reserved word to be used.
 * The issue is once alasql parses the sql the backticks are removed and we need them when we execute the final SQL.
 */
export function backtickASTSchemaItems(statement: any) {
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
 * Create arguments for childProcess fork
 * @param modulePath
 * @returns {*[]}
 */
export function createForkArgs(modulePath: string) {
	return [modulePath];
}

/**
 * Takes a boolean string/value and casts it to a boolean
 * @param boolean
 * @returns {boolean}
 */
export function autoCastBoolean(boolean: any) {
	return boolean === true || (typeof boolean === 'string' && boolean.toLowerCase() === 'true');
}

/**
 * Takes a boolean string/value and casts it to a boolean iff it is a case-insensitive
 * string matching 'true' or 'false'. Returns the argument unmodified otherwise.
 * @param value boolean|string
 * @returns any
 *
 */
export function autoCastBooleanStrict(value: any) {
	if (typeof value === 'string') {
		const lcValue = value.toLowerCase();
		if (lcValue === 'true') {
			return true;
		}
		if (lcValue === 'false') {
			return false;
		}
	}
	return value;
}

/**
 * Gets a tables hash attribute from the global schema
 */
export function getTableHashAttribute(schema: string, table: string) {
	const { getDatabases } = require('../resources/databases');
	let tableObj = getDatabases()[schema]?.[table];
	return tableObj?.primaryKey || tableObj?.hash_attribute;
}

/**
 * Checks the global schema to see if schema exists
 * @param schema
 * @returns {boolean} - returns true if schema exists
 */
export function doesSchemaExist(schema: string) {
	const { getDatabases } = require('../resources/databases');
	return getDatabases()[schema] !== undefined;
}

/**
 * Checks the global schema to see if schema exists
 * @param schema
 * @param table
 * @returns {boolean} - returns true if table exists
 */
export function doesTableExist(schema: string, table: string) {
	const { getDatabases } = require('../resources/databases');
	return getDatabases()[schema]?.[table] !== undefined;
}

/**
 * Tries to stringify an object, if it cant just return that value unchanged.
 * @param value
 * @returns {any}
 */
export function stringifyObj(value: any) {
	try {
		return JSON.stringify(value);
	} catch {
		return value;
	}
}

/**
 * Converts milliseconds to a readable time, e.g. 2d 3h 12m 1s
 * @param ms
 * @returns {*}
 */
export function ms_to_time(ms: number) {
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
export function changeExtension(file: string, extension: string) {
	const basename = path.basename(file, path.extname(file));
	return path.join(path.dirname(file), basename + extension);
}

/**
 * Checks ENV and CLI for ROOTPATH arg
 */
export function getEnvCliRootPath() {
	if (process.env[terms.CONFIG_PARAMS.ROOTPATH.toUpperCase()])
		return process.env[terms.CONFIG_PARAMS.ROOTPATH.toUpperCase()];
	const cliArgs = minimist(process.argv);
	if (cliArgs[terms.CONFIG_PARAMS.ROOTPATH.toUpperCase()]) return cliArgs[terms.CONFIG_PARAMS.ROOTPATH.toUpperCase()];
}

/**
 * Will check to see if there is a rootpath cli/env var pointing to a harperdb-config.yaml file
 * This is used for running HDB without a boot file
 */
let noBootFileChecked;
export function noBootFile() {
	if (noBootFileChecked) return noBootFileChecked;
	const cliEnvRoot = getEnvCliRootPath();
	if (
		getEnvCliRootPath() &&
		(fs.pathExistsSync(path.join(cliEnvRoot, terms.HARPER_CONFIG_FILE)) ||
			fs.pathExistsSync(path.join(cliEnvRoot, terms.HDB_CONFIG_FILE)))
	) {
		noBootFileChecked = true;
		return true;
	}
}

export function httpRequest(options: any, data: any): Promise<http.IncomingMessage & { body?: string }> {
	let client;
	if (options.protocol === 'http:') client = http;
	else client = https;
	// `streamResponse` opts into a non-buffered response shape: the promise resolves as soon
	// as headers arrive, with `response` itself as a Readable. Used by the CLI for SSE
	// (text/event-stream) deploys so progress events render live instead of after the deploy
	// finishes. Strip the flag from `options` before handing it to http.request so it doesn't
	// end up as an unknown option.
	const streamResponse = options.streamResponse === true;
	if (streamResponse) {
		options = { ...options };
		delete options.streamResponse;
	}
	return new Promise((resolve, reject) => {
		const req = client.request(options, (response: http.IncomingMessage & { body?: string }) => {
			if (streamResponse) {
				// Hand the raw stream to the caller; do not setEncoding so binary-safe consumers
				// (or SSE parsers that prefer Buffers) still work.
				resolve(response);
				return;
			}
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

		// A Readable body is streamed with chunked transfer-encoding (e.g. multipart deploys
		// over the 2 GB Buffer cap); .pipe also takes care of closing the request when the
		// source ends. Everything else is sent as a single write.
		if (data && typeof data.pipe === 'function') {
			data.on('error', reject);
			data.pipe(req);
		} else {
			req.write(data instanceof Buffer ? data : JSON.stringify(data));
			req.end();
		}
	});
}

/**
 * Will set default schema/database or set database to schema
 * @param req
 */
export function transformReq(req: any) {
	if (!req.schema && !req.database) {
		req.schema = terms.DEFAULT_DATABASE_NAME;
		return;
	}
	if (req.database) req.schema = req.database;
}

export function convertToMS(interval: any) {
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
import * as hdbErrors from './errors/commonErrors.ts';
