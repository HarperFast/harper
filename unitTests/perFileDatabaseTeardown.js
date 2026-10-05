'use strict';

/**
 * Drops, after each test file, the databases that file created.
 *
 * An open RocksDB database holds ~40 MiB of native memory however little it stores (the lock
 * buckets RocksDB's OptimisticTransactionDB allocates on every open), and getDatabases() reopens
 * every database directory it finds under the storage path, so a database a file creates — or
 * closes but leaves on disk — stays open for the rest of the mocha process. Releasing it means
 * removing it from disk: dropDatabase() for one still registered, and deleting the directory of one
 * the file already closed.
 *
 * Only what did not exist when the file started is touched, and only inside this run's per-PID
 * storage directory. A registered database is skipped when it is `system` or configured, when any
 * of its tables lives outside its own default directory, or when another registered database shares
 * one of its roots: dropDatabase() takes every database sharing a root down with it, and data, dev,
 * test and test2 deliberately alias one root.
 */
const fs = require('node:fs');
const path = require('node:path');
const { PID_DIR_PATH } = require('./perPidRoot.js');

const databasesModulePath = require.resolve('#src/resources/databases');
// mocha.init.js pins storage.path here; a test that points it elsewhere keeps what it creates there
const STORAGE_ROOT = path.join(PID_DIR_PATH, 'database');

/**
 * The database layer, if anything in this process loaded it; a file that never loaded it cannot
 * have created a database, and loading it here would open storage for suites that never touch it.
 */
function loadedDatabasesModule() {
	return require.cache[databasesModulePath]?.exports;
}

function isInside(parentPath, childPath) {
	const relativePath = path.relative(parentPath, childPath);
	return (
		relativePath !== '' &&
		relativePath !== '..' &&
		!relativePath.startsWith('..' + path.sep) &&
		!path.isAbsolute(relativePath)
	);
}

function isRocksDirectory(directoryPath) {
	try {
		const files = fs.readdirSync(directoryPath);
		return files.includes('CURRENT') && files.some((file) => file.startsWith('MANIFEST-'));
	} catch {
		return false;
	}
}

function storageEntries() {
	try {
		return new Set(fs.readdirSync(STORAGE_ROOT));
	} catch {
		return new Set();
	}
}

function tableRoots(tables) {
	const roots = new Set();
	for (const table of Object.values(tables ?? {})) {
		const rootPath = table?.primaryStore?.rootStore?.path;
		if (rootPath) roots.add(rootPath);
	}
	return roots;
}

function isDisposable(databasesModule, configuredDatabases, name) {
	if (name === 'system' || configuredDatabases[name]) return false;
	const storageRoot = databasesModule.resolveDatabaseStorageRoot(name);
	const ownRoots = [path.join(storageRoot, name), path.join(storageRoot, `${name}.mdb`)];
	if (!ownRoots.every((rootPath) => isInside(STORAGE_ROOT, rootPath))) return false;
	// the root dropDatabase() destroys, which for a database with no tables is the only one it has
	if (!ownRoots.includes(databasesModule.database({ database: name }).path)) return false;
	const { databases } = databasesModule;
	for (const rootPath of tableRoots(databases[name])) {
		if (!ownRoots.includes(rootPath)) return false;
	}
	for (const otherName of [...Object.keys(databases), 'system']) {
		if (otherName === name) continue;
		for (const rootPath of tableRoots(databases[otherName])) {
			if (ownRoots.includes(rootPath)) return false;
		}
	}
	return true;
}

function census() {
	const databasesModule = loadedDatabasesModule();
	return {
		names: new Set(databasesModule ? Object.keys(databasesModule.databases) : []),
		entries: storageEntries(),
	};
}

async function dropCreatedSince(atStart, file) {
	const databasesModule = loadedDatabasesModule();
	if (!databasesModule) return;
	const env = require('#src/utility/environment/environmentManager');
	const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
	const { registryStatus } = require('@harperfast/rocksdb-js');
	const configuredDatabases = env.get(CONFIG_PARAMS.DATABASES) || {};
	// a database configured at or inside the storage root scans or nests in the directories dropped
	// here, so ownership can't be told by name or by root; leave the storage root alone
	const storageRootIsShared = Object.values(configuredDatabases).some((config) => {
		if (!config?.path) return false;
		const configuredPath = path.resolve(config.path);
		return configuredPath === STORAGE_ROOT || isInside(STORAGE_ROOT, configuredPath);
	});
	if (storageRootIsShared) return;
	const { databases } = databasesModule;
	const failures = [];
	for (const name of Object.keys(databases)) {
		if (atStart.names.has(name)) continue;
		try {
			if (!isDisposable(databasesModule, configuredDatabases, name)) continue;
			await databasesModule.dropDatabase(name);
		} catch (error) {
			failures.push(new Error(`could not drop database '${name}'`, { cause: error }));
		}
	}
	// closed by the file but still on disk, where the next storage scan would reopen it
	const openRoots = new Set(
		registryStatus()
			.filter((entry) => entry.refCount > 0)
			.map((entry) => path.resolve(entry.path))
	);
	for (const entry of storageEntries()) {
		const rootPath = path.resolve(STORAGE_ROOT, entry);
		if (
			atStart.entries.has(entry) ||
			entry === 'system' ||
			databases[entry] ||
			configuredDatabases[entry] ||
			openRoots.has(rootPath) ||
			!isRocksDirectory(rootPath)
		)
			continue;
		try {
			fs.rmSync(rootPath, { recursive: true, force: true });
		} catch (error) {
			failures.push(new Error(`could not remove closed database directory '${rootPath}'`, { cause: error }));
		}
	}
	if (failures.length > 0) {
		// mocha's reporter prints the message and the cause chain, not AggregateError.errors
		const details = failures
			.map((failure) => `${failure.message}: ${failure.cause?.message ?? failure.cause}`)
			.join('; ');
		throw new AggregateError(failures, `per-file database teardown failed after ${file} — ${details}`, {
			cause: failures[0].cause,
		});
	}
}

/**
 * Appends the teardown as the last after-all hook of each file's last top-level suite that will
 * run its hooks — mocha runs no hooks for a pending suite or one with no tests — so it follows the
 * file's own after hooks. Call from a root before-all hook, before any file has run. Where that
 * suite still does not run (a --grep that excludes it, an earlier after hook that failed), what the
 * file created is dropped by the next file's teardown instead. Root-level hooks and tests (outside
 * any describe) belong to no file, so a database one creates is dropped after whichever file's
 * teardown runs next.
 */
function installPerFileDatabaseTeardown(rootSuite) {
	const lastSuiteOfFile = new Map();
	for (const suite of rootSuite.suites) {
		if (suite.file && !suite.isPending() && suite.total() > 0) lastSuiteOfFile.set(suite.file, suite);
	}
	let atStart = census();
	for (const [file, suite] of lastSuiteOfFile) {
		suite.afterAll('drop the databases this file created', async () => {
			try {
				await dropCreatedSince(atStart, path.relative(process.cwd(), file));
			} finally {
				// report a database that could not be dropped once, not again after every later file
				atStart = census();
			}
		});
	}
}

module.exports = { installPerFileDatabaseTeardown };
