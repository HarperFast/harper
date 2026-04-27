import path from 'path';
import fs from 'fs-extra';
import * as log from './logging/harper_logger.js';
import fsExtra from 'fs-extra';
import os from 'os';
import net from 'net';
import RecursiveIterator from 'recursive-iterator';
import * as terms from './hdbTerms.js';
import { PACKAGE_ROOT } from './packageUtils.js';
import papaParse from 'papaparse';
import moment from 'moment';
import isNumber from 'is-number';
import minimist from 'minimist';
import https from 'https';
import http from 'http';

import * as hdbErrors from './errors/commonErrors.js';

const ISO_DATE =
	/^((\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z)))$/;

import { promisify } from 'node:util';
export const asyncSetTimeout = promisify(setTimeout);

const EMPTY_STRING = '';
const FILE_EXTENSION_LENGTH = 4;

const AUTOCAST_COMMON_STRINGS: Record<string, any> = {
	true: true,
	TRUE: true,
	FALSE: false,
	false: false,
	undefined: null,
	null: null,
	NULL: null,
	NaN: NaN,
};

export function isEmpty(val: any): boolean {
	return val === undefined || val === null || val === '';
}

export function isEmptyOrZeroLength(val: any): boolean {
	return isEmpty(val) || (val && val.length === 0);
}

export function arrayHasEmptyValues(arr: any[]): boolean {
	return arr.some(isEmpty);
}

export function arrayHasEmptyOrZeroLengthValues(arr: any[]): boolean {
	return arr.some(isEmptyOrZeroLength);
}

export function buildFolderPath(...parts: string[]): string {
	return path.join(...parts);
}

export function isBoolean(val: any): boolean {
	return typeof val === 'boolean';
}

export function errorizeMessage(message: any): Error {
	return message instanceof Error ? message : new Error(message);
}

export function stripFileExtension(filename: string): string {
	return filename.replace(/\.[^/.]+$/, '');
}

export function autoCast(val: any): any {
	if (typeof val !== 'string') return val;
	const lower = val.toLowerCase();
	if (AUTOCAST_COMMON_STRINGS[lower] !== undefined) return AUTOCAST_COMMON_STRINGS[lower];
	if (isNumber(val)) return Number(val);
	return val;
}

export function autoCastJSON(val: any): any {
	try {
		return JSON.parse(val);
	} catch {
		return autoCast(val);
	}
}

export function autoCastJSONDeep(obj: any): any {
	if (typeof obj !== 'object' || obj === null) return autoCastJSON(obj);
	for (const key in obj) {
		obj[key] = autoCastJSONDeep(obj[key]);
	}
	return obj;
}

export function removeDir(dir: string): void {
	fs.removeSync(dir);
}

export function compareVersions(v1: string, v2: string): number {
	const p1 = v1.split('.').map(Number);
	const p2 = v2.split('.').map(Number);
	for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
		const n1 = p1[i] || 0;
		const n2 = p2[i] || 0;
		if (n1 > n2) return 1;
		if (n1 < n2) return -1;
	}
	return 0;
}

export function isCompatibleDataVersion(version: string, targetVersion: string): boolean {
	return compareVersions(version, targetVersion) >= 0;
}

export function escapeRawValue(val: any): string {
	return val;
}

export function unescapeValue(val: any): any {
	return val;
}

export function stringifyProps(obj: any): string {
	return JSON.stringify(obj);
}

export function timeoutPromise(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function checkGlobalSchemaTable(schemaName: string, tableName: string): string | undefined {
	const { getDatabases } = require('../resources/databases.js');
	let databases = getDatabases();
	if (!databases[schemaName]) {
		return (hdbErrors as any).HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(schemaName);
	}
	if (!databases[schemaName][tableName]) {
		return (hdbErrors as any).HDB_ERROR_MSGS.TABLE_NOT_FOUND(schemaName, tableName);
	}
}

export function getHomeDir(): string {
	return os.homedir();
}

export function getPropsFilePath(): string {
	return path.join(getHomeDir(), '.harperdb');
}

export function promisifyPapaParse(csv: string, options: any): Promise<any> {
	return new Promise((resolve, reject) => {
		papaParse.parse(csv, {
			...options,
			complete: resolve,
			error: reject,
		});
	});
}

export function removeBOM(content: string): string {
	return content.replace(/^\uFEFF/, '');
}

export function createEventPromise(emitter: any, event: string): Promise<any> {
	return new Promise((resolve) => emitter.once(event, resolve));
}

export function checkSchemaTableExist(schema: string, table: string): string | undefined {
	return checkGlobalSchemaTable(schema, table);
}

export function checkSchemaExists(schema: string): string | undefined {
	const { getDatabases } = require('../resources/databases.js');
	if (!getDatabases()[schema]) {
		return (hdbErrors as any).HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(schema);
	}
}

export function checkTableExists(schema: string, table: string): string | undefined {
	const { getDatabases } = require('../resources/databases.js');
	if (!getDatabases()[schema]?.[table]) {
		return (hdbErrors as any).HDB_ERROR_MSGS.TABLE_NOT_FOUND(schema, table);
	}
}

export function getStartOfTomorrowInSeconds(): number {
	return moment().add(1, 'day').startOf('day').unix();
}

export function getLimitKey(key: string): string {
	return `limit:${key}`;
}

export function isObject(val: any): boolean {
	return val !== null && typeof val === 'object' && !Array.isArray(val);
}

export function isNotEmptyAndHasValue(val: any): boolean {
	return !isEmpty(val);
}

export function autoCasterIsNumberCheck(val: any): boolean {
	return isNumber(val);
}

export function backtickASTSchemaItems(ast: any): void {
	// placeholder
}

export function isPortTaken(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(true));
		server.once('listening', () => {
			server.close();
			resolve(false);
		});
		server.listen(port);
	});
}

export function createForkArgs(args: string[]): string[] {
	return args;
}

export function autoCastBoolean(val: any): boolean | any {
	if (val === 'true' || val === true) return true;
	if (val === 'false' || val === false) return false;
	return val;
}

export function autoCastBooleanStrict(val: any): boolean | undefined {
	if (val === 'true' || val === true) return true;
	if (val === 'false' || val === false) return false;
}

export function getTableHashAttribute(schema: string, table: string): string | undefined {
	const { getDatabases } = require('../resources/databases.js');
	let tableObj = getDatabases()[schema]?.[table];
	return tableObj?.primaryKey || tableObj?.hash_attribute;
}

export function doesSchemaExist(schema: string): boolean {
	const { getDatabases } = require('../resources/databases.js');
	return getDatabases()[schema] !== undefined;
}

export function doesTableExist(schema: string, table: string): boolean {
	const { getDatabases } = require('../resources/databases.js');
	return getDatabases()[schema]?.[table] !== undefined;
}

export function stringifyObj(obj: any): string {
	return JSON.stringify(obj);
}

export function ms_to_time(ms: number): string {
	return (moment as any).duration(ms).humanize();
}

export function changeExtension(filename: string, ext: string): string {
	return filename.replace(/\.[^/.]+$/, ext);
}

export function getEnvCliRootPath(): string | undefined {
	return process.env.HDB_ROOT_PATH;
}

export function noBootFile(): boolean {
	return !fs.existsSync(getPropsFilePath());
}

export function httpRequest(options: any, data?: any): Promise<any> {
	return Promise.resolve();
}

export function transformReq(req: any): any {
	return req;
}

export function convertToMS(timeStr: string): number {
	return 0;
}

export default {
	isEmpty,
	isEmptyOrZeroLength,
	arrayHasEmptyValues,
	arrayHasEmptyOrZeroLengthValues,
	buildFolderPath,
	isBoolean,
	errorizeMessage,
	stripFileExtension,
	autoCast,
	autoCastJSON,
	autoCastJSONDeep,
	removeDir,
	compareVersions,
	isCompatibleDataVersion,
	escapeRawValue,
	unescapeValue,
	stringifyProps,
	timeoutPromise,
	checkGlobalSchemaTable,
	getHomeDir,
	getPropsFilePath,
	promisifyPapaParse,
	removeBOM,
	createEventPromise,
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
	autoCastBooleanStrict,
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
	PACKAGE_ROOT,
};
