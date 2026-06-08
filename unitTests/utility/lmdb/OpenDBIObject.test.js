require('../../testUtils');
const assert = require('assert');
const { OpenDBIObject } = require('#src/utility/lmdb/OpenDBIObject');
const envMngr = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

// Covers the global storage.randomAccessFields path in the OpenDBIObject constructor. The directive
// tests (databases.test.js / randomAccessFieldsDirective.test.js) stamp dbiInit.randomAccessStructure
// in databases.ts before the store opens, bypassing this constructor branch — so a wrong config key,
// a non-boolean value, or a hdbTerms/YAML name mismatch would go uncaught. These open a DBI WITHOUT a
// directive and assert the constructor reads the global config correctly.
describe('OpenDBIObject storage.randomAccessFields global config', () => {
	let previous;
	beforeEach(() => {
		previous = envMngr.get(CONFIG_PARAMS.STORAGE_RANDOMACCESSFIELDS);
	});
	afterEach(() => {
		envMngr.setProperty(CONFIG_PARAMS.STORAGE_RANDOMACCESSFIELDS, previous);
	});

	it('enables randomAccessStructure on a primary DBI when the global config is true', () => {
		envMngr.setProperty(CONFIG_PARAMS.STORAGE_RANDOMACCESSFIELDS, true);
		assert.strictEqual(new OpenDBIObject(false, true).randomAccessStructure, true);
	});

	it('leaves randomAccessStructure off on a primary DBI when the global config is false (default)', () => {
		envMngr.setProperty(CONFIG_PARAMS.STORAGE_RANDOMACCESSFIELDS, false);
		assert.strictEqual(new OpenDBIObject(false, true).randomAccessStructure, false);
	});

	it('keeps randomAccessStructure off on non-primary DBIs even when the global config is true', () => {
		// Non-primary stores (e.g. the __dbis__ metadata DBI) must stay in records mode for v4-downgrade
		// decodability, regardless of the global setting.
		envMngr.setProperty(CONFIG_PARAMS.STORAGE_RANDOMACCESSFIELDS, true);
		assert.strictEqual(new OpenDBIObject(false, false).randomAccessStructure, false);
	});
});
