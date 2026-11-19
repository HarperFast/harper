'use strict';

const assert = require('node:assert');
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

	// Rejected before any file read, so these run without a harper-config.yaml fixture on disk.
	it('set_configuration still rejects a key outside the four registered sql.* settings', async () => {
		await assert.rejects(
			setConfiguration({ operation: 'set_configuration', sql_bogus: true }),
			/Unable to update config, unrecognized config parameter/
		);
	});

	// The `<component>_package` / `<component>_port` escape would otherwise put back the very entry
	// deploy_component now refuses to create.
	for (const param of ['sql_package', 'sql_port']) {
		it(`set_configuration rejects ${param}, which would write a component entry over the sql section`, async () => {
			await assert.rejects(
				setConfiguration({ operation: 'set_configuration', [param]: 'x' }),
				/cannot configure a component whose name is reserved/
			);
		});
	}
});
