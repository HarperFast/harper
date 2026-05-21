'use strict';

const assert = require('node:assert/strict');
const { bootstrapModels } = require('#src/resources/models/bootstrap');
const {
	clearRegistry,
	resolveEmbedding,
	resolveGenerative,
	ModelBackendNotFoundError,
} = require('#src/resources/models/backendRegistry');

describe('bootstrapModels', () => {
	beforeEach(() => clearRegistry());

	it('is a no-op when rootConfig is undefined/null', () => {
		bootstrapModels(undefined);
		bootstrapModels(null);
		assert.throws(() => resolveEmbedding('default'), ModelBackendNotFoundError);
	});

	it('is a no-op when rootConfig.models is absent', () => {
		bootstrapModels({});
		assert.throws(() => resolveEmbedding('default'), ModelBackendNotFoundError);
	});

	it('registers an ollama embedding entry under its logical name', () => {
		bootstrapModels({
			models: {
				embedding: {
					fast: { backend: 'ollama', host: 'localhost:11434', model: 'nomic-embed-text' },
				},
			},
		});
		const backend = resolveEmbedding('fast');
		assert.strictEqual(backend.name, 'ollama');
	});

	it('registers an ollama generative entry under its logical name', () => {
		bootstrapModels({
			models: {
				generative: {
					default: { backend: 'ollama', host: 'localhost:11434', model: 'llama3.2' },
				},
			},
		});
		const backend = resolveGenerative('default');
		assert.strictEqual(backend.name, 'ollama');
	});

	it('skips entries with unknown backend without throwing', () => {
		bootstrapModels({
			models: {
				embedding: {
					default: { backend: 'magic-backend', model: 'm' },
				},
				generative: {
					default: { backend: 'ollama', model: 'm' },
				},
			},
		});
		// The ollama entry on generative still registered.
		assert.strictEqual(resolveGenerative('default').name, 'ollama');
		// The unknown-backend embedding entry was skipped, not registered.
		assert.throws(() => resolveEmbedding('default'), ModelBackendNotFoundError);
	});

	it('skips entries that are not objects', () => {
		bootstrapModels({
			models: {
				embedding: {
					bad: 'just a string',
					good: { backend: 'ollama', model: 'm' },
				},
			},
		});
		assert.strictEqual(resolveEmbedding('good').name, 'ollama');
		assert.throws(() => resolveEmbedding('bad'), ModelBackendNotFoundError);
	});

	it('skips entries missing a backend field', () => {
		bootstrapModels({ models: { embedding: { x: { model: 'm' } } } });
		assert.throws(() => resolveEmbedding('x'), ModelBackendNotFoundError);
	});

	it('registers multiple logical names independently', () => {
		bootstrapModels({
			models: {
				generative: {
					default: { backend: 'ollama', host: 'a:1', model: 'mA' },
					fast: { backend: 'ollama', host: 'b:2', model: 'mB' },
				},
			},
		});
		assert.strictEqual(resolveGenerative('default').name, 'ollama');
		assert.strictEqual(resolveGenerative('fast').name, 'ollama');
	});

	// #630 (Phase 3 of #510): openai-specific bootstrap behavior.
	describe('openai backend (#630)', () => {
		const ENV_VAR = '__HARPER_TEST_BOOTSTRAP_OPENAI__';

		afterEach(() => {
			delete process.env[ENV_VAR];
		});

		it('registers an openai entry under its logical name', () => {
			bootstrapModels({
				models: {
					generative: {
						default: { backend: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' },
					},
				},
			});
			assert.strictEqual(resolveGenerative('default').name, 'openai');
		});

		it('resolves ${ENV_VAR} apiKey before constructing the backend', () => {
			process.env[ENV_VAR] = 'sk-real-key';
			bootstrapModels({
				models: {
					generative: {
						default: { backend: 'openai', apiKey: `\${${ENV_VAR}}`, model: 'gpt-4o-mini' },
					},
				},
			});
			// Successful registration proves the env var resolved (otherwise the
			// backend constructor's `requireApiKey` would throw on the literal
			// placeholder).
			assert.strictEqual(resolveGenerative('default').name, 'openai');
		});

		it('logs error + skips when ${ENV_VAR} apiKey is unset', () => {
			// ENV_VAR is intentionally not set in this test; the placeholder
			// stays literal and the backend constructor throws.
			bootstrapModels({
				models: {
					generative: {
						default: { backend: 'openai', apiKey: `\${${ENV_VAR}}`, model: 'gpt-4o-mini' },
					},
				},
			});
			// Backend was not registered.
			assert.throws(() => resolveGenerative('default'), { name: 'ModelBackendNotFoundError' });
		});

		it('logs error + skips when apiKey is missing entirely', () => {
			bootstrapModels({
				models: {
					generative: {
						default: { backend: 'openai', model: 'gpt-4o-mini' },
					},
				},
			});
			assert.throws(() => resolveGenerative('default'), { name: 'ModelBackendNotFoundError' });
		});

		it('registers ollama + openai entries side by side', () => {
			bootstrapModels({
				models: {
					embedding: {
						'default': { backend: 'ollama', model: 'nomic-embed-text' },
						'high-quality': { backend: 'openai', apiKey: 'sk-test', model: 'text-embedding-3-large' },
					},
					generative: {
						fast: { backend: 'ollama', model: 'llama3.2' },
						default: { backend: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' },
					},
				},
			});
			assert.strictEqual(resolveEmbedding('default').name, 'ollama');
			assert.strictEqual(resolveEmbedding('high-quality').name, 'openai');
			assert.strictEqual(resolveGenerative('fast').name, 'ollama');
			assert.strictEqual(resolveGenerative('default').name, 'openai');
		});
	});
});
