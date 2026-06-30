'use strict';

const assert = require('node:assert/strict');
const { bootstrapModels } = require('#src/resources/models/bootstrap');
const {
	clearRegistry,
	resolveEmbedding,
	resolveGenerative,
	ModelBackendNotFoundError,
} = require('#src/resources/models/backendRegistry');
const { join } = require('node:path');

describe('bootstrapModels', () => {
	beforeEach(() => clearRegistry());

	it('is a no-op when rootConfig is undefined/null', async () => {
		await bootstrapModels(undefined);
		await bootstrapModels(null);
		assert.throws(() => resolveEmbedding('default'), ModelBackendNotFoundError);
	});

	it('is a no-op when rootConfig.models is absent', async () => {
		await bootstrapModels({});
		assert.throws(() => resolveEmbedding('default'), ModelBackendNotFoundError);
	});

	it('registers an ollama embedding entry under its logical name', async () => {
		await bootstrapModels({
			models: {
				embedding: {
					fast: { backend: 'ollama', host: 'localhost:11434', model: 'nomic-embed-text' },
				},
			},
		});
		const backend = resolveEmbedding('fast');
		assert.strictEqual(backend.name, 'ollama');
	});

	it('registers an ollama generative entry under its logical name', async () => {
		await bootstrapModels({
			models: {
				generative: {
					default: { backend: 'ollama', host: 'localhost:11434', model: 'llama3.2' },
				},
			},
		});
		const backend = resolveGenerative('default');
		assert.strictEqual(backend.name, 'ollama');
	});

	it('skips entries with unknown backend without throwing', async () => {
		await bootstrapModels({
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

	it('skips entries that are not objects', async () => {
		await bootstrapModels({
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

	it('skips entries missing a backend field', async () => {
		await bootstrapModels({ models: { embedding: { x: { model: 'm' } } } });
		assert.throws(() => resolveEmbedding('x'), ModelBackendNotFoundError);
	});

	it('skips an entry whose backend is not a string', async () => {
		await bootstrapModels({ models: { embedding: { x: { backend: 123, model: 'm' } } } });
		assert.throws(() => resolveEmbedding('x'), ModelBackendNotFoundError);
	});

	it('registers multiple logical names independently', async () => {
		await bootstrapModels({
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

		it('registers an openai entry under its logical name', async () => {
			await bootstrapModels({
				models: {
					generative: {
						default: { backend: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' },
					},
				},
			});
			assert.strictEqual(resolveGenerative('default').name, 'openai');
		});

		it('resolves ${ENV_VAR} apiKey before constructing the backend', async () => {
			process.env[ENV_VAR] = 'sk-real-key';
			await bootstrapModels({
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

		it('logs error + skips when ${ENV_VAR} apiKey is unset', async () => {
			// ENV_VAR is intentionally not set in this test; the placeholder
			// stays literal and the backend constructor throws.
			await bootstrapModels({
				models: {
					generative: {
						default: { backend: 'openai', apiKey: `\${${ENV_VAR}}`, model: 'gpt-4o-mini' },
					},
				},
			});
			// Backend was not registered.
			assert.throws(() => resolveGenerative('default'), { name: 'ModelBackendNotFoundError' });
		});

		it('logs error + skips when apiKey is missing entirely', async () => {
			await bootstrapModels({
				models: {
					generative: {
						default: { backend: 'openai', model: 'gpt-4o-mini' },
					},
				},
			});
			assert.throws(() => resolveGenerative('default'), { name: 'ModelBackendNotFoundError' });
		});

		it('registers ollama + openai entries side by side', async () => {
			await bootstrapModels({
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

	// #633 (Phase 6): anthropic + bedrock entries.
	describe('anthropic + bedrock backends (#633)', () => {
		it('registers an anthropic generative entry', async () => {
			await bootstrapModels({
				models: {
					generative: {
						claude: { backend: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-opus-4-7' },
					},
				},
			});
			assert.strictEqual(resolveGenerative('claude').name, 'anthropic');
		});

		it('registers a bedrock generative entry (SDK loads lazily; construction is cheap)', async () => {
			await bootstrapModels({
				models: {
					generative: {
						'bedrock-claude': {
							backend: 'bedrock',
							region: 'us-east-1',
							model: 'anthropic.claude-opus-4-v1:0',
						},
					},
				},
			});
			assert.strictEqual(resolveGenerative('bedrock-claude').name, 'bedrock');
		});

		it('registers a bedrock embedding entry', async () => {
			await bootstrapModels({
				models: {
					embedding: {
						titan: { backend: 'bedrock', region: 'us-east-1', model: 'amazon.titan-embed-text-v2:0' },
					},
				},
			});
			assert.strictEqual(resolveEmbedding('titan').name, 'bedrock');
		});

		it('logs error + skips when an anthropic embedding entry is configured (no Anthropic embed API)', async () => {
			await bootstrapModels({
				models: {
					embedding: {
						oops: { backend: 'anthropic', apiKey: 'sk-ant', model: 'claude' },
					},
				},
			});
			assert.throws(() => resolveEmbedding('oops'), { name: 'ModelBackendNotFoundError' });
		});

		it('all four backends side by side', async () => {
			await bootstrapModels({
				models: {
					embedding: {
						local: { backend: 'ollama', model: 'nomic-embed-text' },
						hq: { backend: 'openai', apiKey: 'sk', model: 'text-embedding-3-large' },
						titan: { backend: 'bedrock', region: 'us-east-1', model: 'amazon.titan-embed-text-v2:0' },
					},
					generative: {
						'local-llm': { backend: 'ollama', model: 'llama3.2' },
						'gpt': { backend: 'openai', apiKey: 'sk', model: 'gpt-4o-mini' },
						'claude': { backend: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-4-7' },
						'bedrock-claude': {
							backend: 'bedrock',
							region: 'us-east-1',
							model: 'anthropic.claude-opus-4-v1:0',
						},
					},
				},
			});
			assert.strictEqual(resolveEmbedding('local').name, 'ollama');
			assert.strictEqual(resolveEmbedding('hq').name, 'openai');
			assert.strictEqual(resolveEmbedding('titan').name, 'bedrock');
			assert.strictEqual(resolveGenerative('local-llm').name, 'ollama');
			assert.strictEqual(resolveGenerative('gpt').name, 'openai');
			assert.strictEqual(resolveGenerative('claude').name, 'anthropic');
			assert.strictEqual(resolveGenerative('bedrock-claude').name, 'bedrock');
		});
	});

	// #1471: a non-built-in `backend` value is resolved as a module specifier.
	describe('module backends (#1471)', () => {
		const FIXTURES = join(__dirname, 'fixtures');

		it('registers a backend from a module specifier (default-export factory)', async () => {
			await bootstrapModels({
				models: {
					embedding: {
						local: { backend: join(FIXTURES, 'embed-backend-module.cjs'), model: 'bge-test' },
					},
				},
			});
			assert.strictEqual(resolveEmbedding('local').name, 'module:bge-test');
		});

		it('skips a module that exports no usable factory', async () => {
			await bootstrapModels({
				models: {
					embedding: {
						bad: { backend: join(FIXTURES, 'no-factory-module.cjs'), model: 'm' },
					},
				},
			});
			assert.throws(() => resolveEmbedding('bad'), ModelBackendNotFoundError);
		});

		it('skips an unimportable backend specifier; a sibling built-in still registers', async () => {
			await bootstrapModels({
				models: {
					embedding: {
						nope: { backend: '@harper-test/does-not-exist', model: 'm' },
						good: { backend: 'ollama', model: 'nomic-embed-text' },
					},
				},
			});
			assert.throws(() => resolveEmbedding('nope'), ModelBackendNotFoundError);
			assert.strictEqual(resolveEmbedding('good').name, 'ollama');
		});

		it('registers from a module with a named `register` export', async () => {
			await bootstrapModels({
				models: { embedding: { r: { backend: join(FIXTURES, 'register-export-module.cjs'), model: 'm' } } },
			});
			assert.strictEqual(resolveEmbedding('r').name, 'module:register-export');
		});

		it('registers from a default class with a static `register` method', async () => {
			await bootstrapModels({
				models: { embedding: { c: { backend: join(FIXTURES, 'class-register-module.cjs'), model: 'm' } } },
			});
			assert.strictEqual(resolveEmbedding('c').name, 'module:class-register');
		});

		it('resolves a relative specifier against the Harper instance root', async () => {
			const env = require('#src/utility/environment/environmentManager');
			const prev = env.getHdbBasePath();
			env.setHdbBasePath(FIXTURES);
			try {
				await bootstrapModels({
					models: { embedding: { rel: { backend: './embed-backend-module.cjs', model: 'rel-test' } } },
				});
				assert.strictEqual(resolveEmbedding('rel').name, 'module:rel-test');
			} finally {
				env.setHdbBasePath(prev);
			}
		});
	});
});
