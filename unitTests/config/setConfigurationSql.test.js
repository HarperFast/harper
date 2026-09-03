'use strict';

// `getConfigValue`/`set_configuration` resolve a name only if it is present in CONFIG_PARAM_MAP,
// which is populated from CONFIG_PARAMS by lowercased name. An unregistered param therefore reads
// as `undefined` forever: the configured value is silently ignored, its compiled-in default always
// applies, and set_configuration rejects it as unrecognized. That is exactly how sql.engine/
// allowFullScan/maxSortRows/maxHashRows shipped inert — nothing ever registered them, and the only
// production reader was a globalThis.harperConfig branch that nothing ever assigned either. This
// guards the registration; sqlEngine/config.ts's own tests guard that the accessor actually reads
// the registered value.

const assert = require('node:assert/strict');
const { CONFIG_PARAMS, CONFIG_PARAM_MAP } = require('#src/utility/hdbTerms');
const { setConfiguration } = require('#src/config/configUtils');

describe('sql.* config param registration', () => {
	const SQL_PARAMS = {
		SQL_ENGINE: 'sql_engine',
		SQL_ALLOWFULLSCAN: 'sql_allowFullScan',
		SQL_MAXSORTROWS: 'sql_maxSortRows',
		SQL_MAXHASHROWS: 'sql_maxHashRows',
	};

	for (const [key, expected] of Object.entries(SQL_PARAMS)) {
		it(`${key} is registered in CONFIG_PARAMS so getConfigValue can resolve it`, () => {
			assert.strictEqual(CONFIG_PARAMS[key], expected);
		});

		it(`${key} is reachable through CONFIG_PARAM_MAP, so set_configuration accepts it`, () => {
			assert.strictEqual(CONFIG_PARAM_MAP[expected.toLowerCase()], expected);
		});
	}

	// Rejected before any file read (findUnrecognizedParams runs first), so this is safe to run
	// without a real harper-config.yaml fixture on disk.
	it('set_configuration still rejects a key outside the four registered sql.* settings', async () => {
		await assert.rejects(
			setConfiguration({ operation: 'set_configuration', sql_bogus: true }),
			/Unable to update config, unrecognized config parameter/
		);
	});
});
