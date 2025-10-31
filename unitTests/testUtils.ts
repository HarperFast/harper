import path from 'node:path';
import { isMainThread } from 'node:worker_threads';
import * as env from '@/utility/environment/environmentManager';
import * as terms from '@/utility/hdbTerms';
import { resetDatabases } from '@/resources/databases';
import * as fs from 'fs-extra';
import { stringify } from 'yaml';

const UNIT_TEST_DIR = __dirname;
const ENV_DIR_NAME = 'testEnv';
const ENV_DIR_PATH = path.join(UNIT_TEST_DIR, ENV_DIR_NAME);

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

		delete global.hdb_schema;
		global.lmdb_map = undefined;
		if (!partial_teardown) {
			await fs.remove(ENV_DIR_PATH);
		}
	} catch (err) {}
}

export function getMockLMDBPath() {
	let lmdbPath = path.join(UNIT_TEST_DIR, ENV_DIR_NAME, process.pid.toString());
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, lmdbPath);
	env.setProperty(terms.CONFIG_PARAMS.DATABASES, { data: { path: lmdbPath }, dev: { path: lmdbPath } });
	resetDatabases();
	if (isMainThread) {
		process.on('exit', () => tearDownMockDB());
	}
	return lmdbPath;
}

export function createTestSandbox() {
	const lmdbPath = getMockLMDBPath();
	process.env.OVERRIDE_HOME_DIR = lmdbPath;
	const storagePath = path.join(lmdbPath, 'database');
	process.env.STORAGE_PATH = storagePath;
	const bootPropsPath = path.join(lmdbPath, terms.HDB_HOME_DIR_NAME);
	fs.mkdirpSync(storagePath);
	fs.writeFileSync(
		path.join(lmdbPath, 'harperdb-config.yaml'),
		stringify({
			rootPath: lmdbPath,
			logging: {
				path: path.join(lmdbPath, 'logs'),
				file: false,
				stdStreams: false,
				auditLog: false,
			},
			localStudio: {},
			operationsApi: {},
			http: {},
			storage: { writeAsync: false },
		})
	);
	fs.mkdirpSync(bootPropsPath);
	fs.writeFileSync(
		path.join(bootPropsPath, terms.BOOT_PROPS_FILE_NAME),
		`settings_path = ${lmdbPath}/harperdb-config.yaml`
	);
	return lmdbPath;
}

export async function cleanupTestSandbox() {
	delete process.env.OVERRIDE_HOME_DIR;
	await tearDownMockDB();
}

export async function waitUntilDefined(value) {
	const maxAttempts = 100;
	for (let i = 0; i < maxAttempts; i++) {
		if (value !== undefined) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}
