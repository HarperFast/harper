'use strict';

/**
 * Packaging invariants for the `/v1/*` gateway (#631).
 *
 * The gateway is registered in componentLoader's built-in table, so the root
 * loader reaches it for any config that declares a `modelsGateway` key — the
 * only pre-resolution guard is `if (!componentConfig) continue`, and
 * `{ enabled: false }` is a truthy object. Shipping the block in
 * `defaultConfig.yaml` would therefore import the whole `/v1` module graph on
 * every startup and every worker of every instance, including the overwhelming
 * majority that never enable it — `handleApplication` would then immediately
 * return on its `enabled` check, having already paid for the import.
 *
 * Keeping the key out of the shipped default config is what makes "off" cost
 * nothing. These tests pin that, plus the `set_configuration` route that
 * replaces the config-file block as the discoverable way to turn it on.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { CONFIG_PARAM_MAP, CONFIG_PARAMS } = require('#src/utility/hdbTerms');

// unitTests/resources/models/v1 -> repo root
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', '..', '..', 'static', 'defaultConfig.yaml');

describe('/v1 gateway packaging', () => {
	it('defaultConfig.yaml ships no modelsGateway block, so a disabled instance imports nothing', () => {
		const raw = fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8');
		const parsed = YAML.parse(raw);

		assert.ok(parsed, 'defaultConfig.yaml should parse');
		assert.strictEqual(
			Object.hasOwn(parsed, 'modelsGateway'),
			false,
			'defaultConfig.yaml must not declare `modelsGateway`: a present key (even `enabled: false`) makes the ' +
				'root loader resolve and import the /v1 module graph on every startup and worker. Document the ' +
				'option in the docs, not by shipping an inert config block.'
		);
	});

	it('modelsGateway_enabled is settable via set_configuration', () => {
		// With no block in the shipped config, the ops API is the discoverable way to
		// enable the gateway. set_configuration resolves params through CONFIG_PARAM_MAP
		// and throws `unrecognized config parameter` for anything missing from it.
		assert.strictEqual(CONFIG_PARAMS.MODELSGATEWAY_ENABLED, 'modelsGateway_enabled');
		assert.strictEqual(
			CONFIG_PARAM_MAP['modelsgateway_enabled'],
			'modelsGateway_enabled',
			'CONFIG_PARAM_MAP is populated from CONFIG_PARAMS by lowercased name; without the entry, ' +
				'set_configuration rejects modelsGateway_enabled as unrecognized'
		);
	});
});
