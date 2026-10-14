'use strict';

const assert = require('node:assert');
const { existsSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { setConfiguration, getConfigFilePath, initConfig } = require('#src/config/configUtils');
const { getBackupDirPath } = require('#src/config/configHelpers');
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

	it('boots with prototype-named models, clears the block, and restores the startup value', async () => {
		const configPath = getConfigFilePath();
		const saved = readFileSync(configPath, 'utf8');
		const startupModels = {
			generative: {
				hasOwnProperty: { backend: 'ollama', model: 'fixture' },
				['__proto__']: { backend: 'ollama', model: 'fixture' },
			},
		};
		try {
			await setConfiguration({ operation: 'set_configuration', models: startupModels });
			initConfig(true);
			await setConfiguration({ operation: 'set_configuration', models: {} });
			assert.deepStrictEqual(readRootConfig().models, {});
			await setConfiguration({ operation: 'set_configuration', models: startupModels });
			assert.deepStrictEqual(readRootConfig().models, startupModels);
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

	it('keeps a replacement through reload when the defaults supplied the old entry', async () => {
		const saved = process.env.HARPER_DEFAULT_CONFIG;
		const configPath = getConfigFilePath();
		const savedConfig = readFileSync(configPath, 'utf8');
		const statePath = join(getBackupDirPath(readRootConfig().rootPath), '.harper-config-state.json');
		const savedState = existsSync(statePath) ? readFileSync(statePath) : undefined;
		try {
			await setConfiguration({ operation: 'set_configuration', models: {} });
			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({ models: { generative: { old: { backend: 'ollama' } } } });
			initConfig(true);
			assert.strictEqual(readRootConfig().models.generative.old.backend, 'ollama');
			await setConfiguration({ operation: 'set_configuration', models });
			initConfig(true);
			assert.deepStrictEqual(readRootConfig().models, models);
		} finally {
			if (saved === undefined) delete process.env.HARPER_DEFAULT_CONFIG;
			else process.env.HARPER_DEFAULT_CONFIG = saved;
			writeFileSync(configPath, savedConfig);
			if (savedState === undefined) rmSync(statePath, { force: true });
			else writeFileSync(statePath, savedState);
			initConfig(true);
		}
	});

	it('ignores empty environment model blocks, which impose no settings', async () => {
		for (const layer of ['HARPER_SET_CONFIG', 'HARPER_CONFIG']) {
			const saved = process.env[layer];
			try {
				for (const empty of [{ models: {} }, { 'models.generative': {} }]) {
					process.env[layer] = JSON.stringify(empty);
					await setConfiguration({ operation: 'set_configuration', models });
					assert.deepStrictEqual(readRootConfig().models, models);
				}
			} finally {
				if (saved === undefined) delete process.env[layer];
				else process.env[layer] = saved;
			}
		}
	});
});
