require('../../testUtils');
const assert = require('assert');
const sinon = require('sinon');
const { OpenDBIObject } = require('#src/utility/lmdb/OpenDBIObject');
const envMngr = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

// Covers the global storage.randomAccessFields path in the OpenDBIObject constructor. The directive
// tests (databases.test.js / randomAccessFieldsDirective.test.js) stamp dbiInit.randomAccessStructure
// in databases.ts before the store opens, bypassing this constructor branch — so a wrong config key,
// a non-boolean value, or a hdbTerms/YAML name mismatch would go uncaught.
//
// The constructor reads the value via envMngr.get(CONFIG_PARAMS.STORAGE_RANDOMACCESSFIELDS), so we
// stub that getter per-test (restored in afterEach) rather than mutating shared config state — the
// latter is order-dependent across the full unit suite and isn't reliably isolated. callThrough()
// keeps every other config read (e.g. STORAGE_CACHING) on the real value; only the random-access
// key is forced, which also asserts the constructor reads the *correct* key (a wrong key would fall
// through to the real value and fail these assertions).
describe('OpenDBIObject storage.randomAccessFields global config', () => {
	let getStub;
	afterEach(() => {
		if (getStub) {
			getStub.restore();
			getStub = undefined;
		}
	});

	function stubRandomAccessFields(value) {
		getStub = sinon.stub(envMngr, 'get');
		getStub.callThrough();
		getStub.withArgs(CONFIG_PARAMS.STORAGE_RANDOMACCESSFIELDS).returns(value);
	}

	it('enables randomAccessStructure on a primary DBI when the global config is true', () => {
		stubRandomAccessFields(true);
		assert.strictEqual(new OpenDBIObject(false, true).randomAccessStructure, true);
	});

	it('leaves randomAccessStructure off on a primary DBI when the global config is false (default)', () => {
		stubRandomAccessFields(false);
		assert.strictEqual(new OpenDBIObject(false, true).randomAccessStructure, false);
	});

	it('treats a non-boolean truthy config value as off (strict === true)', () => {
		// envMngr should hand back a real boolean; guard the strict comparison so a stray truthy
		// (e.g. the string "true") can't silently flip encoding on.
		stubRandomAccessFields('true');
		assert.strictEqual(new OpenDBIObject(false, true).randomAccessStructure, false);
	});

	it('keeps randomAccessStructure off on non-primary DBIs even when the global config is true', () => {
		// Non-primary stores (e.g. the __dbis__ metadata DBI) must stay in records mode for
		// v4-downgrade decodability, regardless of the global setting.
		stubRandomAccessFields(true);
		assert.strictEqual(new OpenDBIObject(false, false).randomAccessStructure, false);
	});
});
