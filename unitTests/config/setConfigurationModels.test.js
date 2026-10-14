'use strict';

const assert = require('node:assert');
const { readFileSync, writeFileSync } = require('node:fs');
const { setConfiguration, getConfigFilePath, initConfig } = require('#src/config/configUtils');
const { CONFIG_PARAM_MAP } = require('#src/utility/hdbTerms');
const { preserveRootConfig, readRootConfig, setRootConfigEntry } = require('../rootConfigFixture.js');

describe('set_configuration models block', () => {
	preserveRootConfig();
	const models = {
		embedding: { 'named_model.v1': { backend: 'ollama', model: 'nomic-embed-text' } },
		generative: { default: { backend: 'openai', model: 'fixture', apiKey: '${MODEL_API_KEY}' } },
		decision: { classify: { backend: 'generative', generative: 'default', samples: 2 } },
	};

	it('persists named models and credential placeholders without registering bare MODELS env ingestion', async () => {
		assert.strictEqual(CONFIG_PARAM_MAP.models, undefined);
		await setConfiguration({ operation: 'set_configuration', models });
		assert.deepStrictEqual(readRootConfig().models, models);
	});

	it('replaces the complete block with an object encoded as JSON', async () => {
		setRootConfigEntry('models', { generative: { old: { backend: 'ollama', model: 'old' } } });
		await setConfiguration({ operation: 'set_configuration', MODELS: JSON.stringify(models) });
		assert.deepStrictEqual(readRootConfig().models, models);
	});

	it('can clear the block and restore the startup value after a different value was written', async () => {
		const configPath = getConfigFilePath();
		const saved = readFileSync(configPath, 'utf8');
		try {
			setRootConfigEntry('models', models);
			initConfig(true);
			await setConfiguration({ operation: 'set_configuration', models: {} });
			assert.deepStrictEqual(readRootConfig().models, {});
			await setConfiguration({ operation: 'set_configuration', models });
			assert.deepStrictEqual(readRootConfig().models, models);
		} finally {
			writeFileSync(configPath, saved);
			initConfig(true);
		}
	});

	for (const invalid of [
		null,
		[],
		'5',
		'invalid',
		{ generative: { default: {} } },
		{ generative: { default: { backend: 'ollama', hsot: 'localhost' } } },
		{ generative: { default: { backend: 'ollama', requestTimeoutMs: 0 } } },
	]) {
		it(`rejects ${JSON.stringify(invalid)} without writing any part of the request`, async () => {
			const before = readFileSync(getConfigFilePath(), 'utf8');
			await assert.rejects(
				setConfiguration({ operation: 'set_configuration', logging_level: 'fatal', models: invalid }),
				(error) => error.statusCode === 400 && /config file validation error/.test(error.message)
			);
			assert.strictEqual(readFileSync(getConfigFilePath(), 'utf8'), before);
		});
	}

	for (const layer of ['HARPER_SET_CONFIG', 'HARPER_CONFIG']) {
		it(`rejects a models write when ${layer} pins the model configuration`, async () => {
			const saved = process.env[layer];
			const before = readFileSync(getConfigFilePath(), 'utf8');
			process.env[layer] = JSON.stringify({ 'models.generative.default.backend': 'ollama' });
			try {
				await assert.rejects(
					setConfiguration({ operation: 'set_configuration', models }),
					(error) => error.statusCode === 409 && error.message.includes(layer)
				);
				assert.strictEqual(readFileSync(getConfigFilePath(), 'utf8'), before);
			} finally {
				if (saved === undefined) delete process.env[layer];
				else process.env[layer] = saved;
			}
		});
	}

	it('allows replacing environment defaults, which yield to user edits on restart', async () => {
		const saved = process.env.HARPER_DEFAULT_CONFIG;
		process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ models: { generative: { old: { backend: 'ollama' } } } });
		try {
			await setConfiguration({ operation: 'set_configuration', models });
			assert.deepStrictEqual(readRootConfig().models, models);
		} finally {
			if (saved === undefined) delete process.env.HARPER_DEFAULT_CONFIG;
			else process.env.HARPER_DEFAULT_CONFIG = saved;
		}
	});
});
