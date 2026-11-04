'use strict';
const assert = require('node:assert');
const { getConfigObj } = require('#src/config/configUtils');
const { configValidator } = require('#src/validation/configValidator');
const { CONFIG_PARAMS, CONFIG_PARAM_MAP } = require('#src/utility/hdbTerms');

describe('health-check configuration', function () {
	const validate = (healthChecks) =>
		configValidator({ ...structuredClone(getConfigObj()), status: { healthChecks } }, true);
	it('registers CLI, environment and set_configuration names', function () {
		assert.equal(CONFIG_PARAM_MAP.status_healthchecks_enabled, CONFIG_PARAMS.STATUS_HEALTHCHECKS_ENABLED);
		assert.equal(
			CONFIG_PARAM_MAP.status_healthchecks_intervalseconds,
			CONFIG_PARAMS.STATUS_HEALTHCHECKS_INTERVALSECONDS
		);
	});
	it('accepts disabling and custom thresholds', function () {
		assert.ifError(
			validate({ enabled: false, intervalSeconds: 1, thresholds: { disk: { warning: 85, error: 96 } } }).error
		);
	});
	it('rejects tight loops, non-finite intervals and crossed thresholds including partial overrides', function () {
		for (const healthChecks of [
			{ enabled: 'false' },
			{ intervalSecond: 1 },
			{ tresholds: {} },
			{ thresholds: { disk: { warn: 80 } } },
			{ thresholds: { disks: { warning: 80 } } },
			{ intervalSeconds: '1' },
			{ thresholds: { disk: { warning: '80' } } },
			{ intervalSeconds: 0.001 },
			{ intervalSeconds: Infinity },
			{ thresholds: { disk: { warning: 96 } } },
			{ thresholds: { memory: { error: 70 } } },
			{ thresholds: { cpu: { warning: 90, error: 80 } } },
		])
			assert.ok(validate(healthChecks).error, JSON.stringify(healthChecks));
	});
});
