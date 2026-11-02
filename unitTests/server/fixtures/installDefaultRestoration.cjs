'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

async function run() {
	const [phase, envVar, introducedBy] = process.argv.slice(2);
	const root = process.env.ROOTPATH;
	const defaults = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../../../static/defaultConfig.yaml'), 'utf8'));
	if (phase === 'install') {
		const installEnv = Object.fromEntries(
			['HDB_CONFIG', 'HARPER_DEFAULT_CONFIG', 'HARPER_CONFIG', 'HARPER_SET_CONFIG'].map((key) => [
				key,
				process.env[key],
			])
		);
		for (const key of Object.keys(installEnv)) delete process.env[key];
		const { install } = require('#src/utility/install/installer');
		Object.assign(process.env, installEnv);
		await install();
		const saved = YAML.parse(fs.readFileSync(path.join(root, 'harper-config.yaml'), 'utf8'));
		assert.strictEqual(saved.authentication.cacheTTL, 60000);
		const state = JSON.parse(fs.readFileSync(path.join(root, 'backup/.harper-config-state.json'), 'utf8'));
		assert.strictEqual(state.originalValues['authentication.cacheTTL'], defaults.authentication.cacheTTL);
		assert.strictEqual(state.sources['authentication.cacheTTL'], envVar);
		assert.strictEqual(state.sources['authentication.authorizeLocal'], introducedBy === 'arg' ? 'user' : envVar);
		assert.strictEqual(state.sources['authentication.enableSessions'], undefined);
		if (introducedBy === 'env') {
			assert.deepStrictEqual(saved.applications.allowedSpawnCommands, [
				...defaults.applications.allowedSpawnCommands,
				'bun',
			]);
			assert.strictEqual(saved.mqtt.requireAuthentication, false);
		}
		await require('#src/resources/databases').closeLoadedDatabases();
	} else {
		const config = require('#src/config/configUtils');
		config.initConfig(true);
		const restored = config.getConfigObj();
		assert.strictEqual(restored.authentication.cacheTTL, defaults.authentication.cacheTTL);
		assert.strictEqual(restored.authentication.authorizeLocal, introducedBy === 'arg');
		assert.strictEqual(restored.authentication.enableSessions, defaults.authentication.enableSessions);
		if (introducedBy === 'env') {
			assert.strictEqual(restored.mqtt.requireAuthentication, true);
			assert.strictEqual(restored.mqtt.network.port, defaults.mqtt.network.port);
			assert.deepStrictEqual(restored.applications.allowedSpawnCommands, defaults.applications.allowedSpawnCommands);
		} else {
			assert.strictEqual(restored.mqtt, undefined);
			assert.strictEqual(restored.applications, undefined);
		}
		assert.strictEqual(restored.http.port, null);
		assert.strictEqual(restored.http.securePort, null);
		assert.strictEqual(restored.operationsApi.network.cors, false);
		const state = JSON.parse(fs.readFileSync(path.join(root, 'backup/.harper-config-state.json'), 'utf8'));
		assert.strictEqual(state.sources['authentication.cacheTTL'], undefined);
		assert.strictEqual(state.sources['authentication.enableSessions'], undefined);
	}
	console.log('install-default-restoration-ok');
}

run().then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	}
);
