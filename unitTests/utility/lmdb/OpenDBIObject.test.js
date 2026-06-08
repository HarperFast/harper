require('../../testUtils');
const assert = require('assert');
const { OpenDBIObject } = require('#src/utility/lmdb/OpenDBIObject');
const envMngr = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

// Covers the global storage.randomAccessFields path in the OpenDBIObject constructor. The directive
// tests (databases.test.js / randomAccessFieldsDirective.test.js) stamp dbiInit.randomAccessStructure
// in databases.ts before the store opens, bypassing this constructor branch — so a wrong config key,
// a non-boolean value, or a hdbTerms/YAML name mismatch would go uncaught.
//
// The constructor reads the value via envMngr.get(CONFIG_PARAMS.STORAGE_RANDOMACCESSFIELDS). We
// temporarily override that single getter via defineProperty (restored in a finally) rather than
// using sinon or envMngr.setProperty: another test in the full unit suite leaves envMngr.get wrapped
// by sinon, which (a) makes setProperty's value invisible behind that stub and (b) makes a second
// sinon.stub throw "already wrapped". Saving/replacing/restoring the property descriptor is immune to
// that — the replacement delegates to whatever get currently is (real or another test's stub) for
// every other key, and restores the exact prior descriptor afterward.
function withRandomAccessFields(value, fn) {
	const previousDescriptor = Object.getOwnPropertyDescriptor(envMngr, 'get');
	const currentGet = envMngr.get;
	Object.defineProperty(envMngr, 'get', {
		configurable: true,
		writable: true,
		value: (key) => (key === CONFIG_PARAMS.STORAGE_RANDOMACCESSFIELDS ? value : currentGet(key)),
	});
	try {
		fn();
	} finally {
		Object.defineProperty(envMngr, 'get', previousDescriptor);
	}
}

describe('OpenDBIObject storage.randomAccessFields global config', () => {
	it('enables randomAccessStructure on a primary DBI when the global config is true', () => {
		withRandomAccessFields(true, () => {
			assert.strictEqual(new OpenDBIObject(false, true).randomAccessStructure, true);
		});
	});

	it('leaves randomAccessStructure off on a primary DBI when the global config is false (default)', () => {
		withRandomAccessFields(false, () => {
			assert.strictEqual(new OpenDBIObject(false, true).randomAccessStructure, false);
		});
	});

	it('treats a non-boolean truthy config value as off (strict === true)', () => {
		// envMngr should hand back a real boolean; the strict === true guards against a stray truthy
		// (e.g. the string "true") silently flipping encoding on.
		withRandomAccessFields('true', () => {
			assert.strictEqual(new OpenDBIObject(false, true).randomAccessStructure, false);
		});
	});

	it('keeps randomAccessStructure off on non-primary DBIs even when the global config is true', () => {
		// Non-primary stores (e.g. the __dbis__ metadata DBI) must stay in records mode for
		// v4-downgrade decodability, regardless of the global setting.
		withRandomAccessFields(true, () => {
			assert.strictEqual(new OpenDBIObject(false, false).randomAccessStructure, false);
		});
	});
});
