'use strict';

const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const envMngr = require('#src/utility/environment/environmentManager');
const hdbTerms = require('#src/utility/hdbTerms');
const { createEnvironment, closeEnvironment } = require('#src/utility/lmdb/environmentUtility');

// createEnvironment records each database's path in the `databases` config map, keyed by the database
// directory's name. A name that is also an inherited property must still become an own, serializable
// entry, and must never put `path` on Object.prototype or the Object constructor (GHSA).
describe('LMDB environment config keys named after inherited properties', function () {
	let rootDir;

	before(function () {
		rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper.unit-test.env-config-keys-'));
	});

	after(function () {
		fs.rmSync(rootDir, { recursive: true, force: true });
	});

	for (const dbName of ['__proto__', 'constructor', 'toString']) {
		it(`records '${dbName}' as an own config entry without touching shared prototypes`, async function () {
			const basePath = path.join(rootDir, dbName);
			fs.mkdirSync(basePath);
			const env = await createEnvironment(basePath, 'tbl');
			const databasesConfig = envMngr.get(hdbTerms.CONFIG_PARAMS.DATABASES);
			try {
				assert.ok(Object.hasOwn(databasesConfig, dbName), `'${dbName}' must be an own key of the config map`);
				assert.strictEqual(databasesConfig[dbName].path, basePath);
				assert.strictEqual(JSON.parse(JSON.stringify(databasesConfig))[dbName]?.path, basePath);
				assert.strictEqual(Object.getPrototypeOf(databasesConfig), Object.prototype);
				assert.strictEqual({}.path, undefined, 'Object.prototype gained a path');
				assert.strictEqual(Object.path, undefined, 'the Object constructor gained a path');
			} finally {
				await closeEnvironment(env);
				delete databasesConfig[dbName];
				delete Object.prototype.path;
				delete Object.path;
			}
		});
	}
});
