'use strict';

const assert = require('node:assert');
const { join } = require('node:path');
const { setupTestDBPath } = require('../../testUtils');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { createGenerativeDecisionBackend } = require('#src/resources/models/generativeDecision');
const { bootstrapModels, resetModelsProjection } = require('#src/resources/models/bootstrap');
const {
	clearRegistry,
	defineBackend,
	getBackend,
	getBackendSource,
	SERVED_SOURCE,
	setGenerative,
} = require('#src/resources/models/backendRegistry');
const { clearRouting } = require('#src/resources/models/routing');
const { models } = require('#src/resources/models/Models');
const { sourceFingerprint, resetDecisionTables } = require('#src/resources/models/decisionStore');
const { configureCalibration, resetCalibrationsTable } = require('#src/resources/models/calibrationStore');

const QUEUE = { enum: ['billing', 'refund', 'bug', 'other'] };
const FLAKY = join(__dirname, 'fixtures', 'flaky-json-generative-module.cjs');
const BASE = 'generative=default;mode=vote;samples=3;temperature=default';

/** An injected `generate` that reports the given sources, one per call, through the adapter's hook. */
function reporting(sources) {
	const seen = [];
	let i = 0;
	const generate = async (_input, opts) => {
		seen.push(opts);
		const hook = opts[SERVED_SOURCE];
		if (hook) hook(sources[i++ % sources.length]);
		return { content: '{"value":"bug"}' };
	};
	return { generate, seen };
}

async function decideWith(sources) {
	const r = reporting(sources);
	const backend = createGenerativeDecisionBackend(
		{ samples: 3, concurrency: 1, scoring: 'vote' },
		{ generate: r.generate }
	);
	const result = await backend.decide('x', QUEUE, { accounting: {} });
	return { signature: result.output.signature, seen: r.seen };
}

describe('score-source identity for calibration (#2841)', () => {
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		resetDecisionTables();
		resetCalibrationsTable();
	});

	afterEach(() => {
		configureCalibration(undefined, false);
		clearRegistry();
		clearRouting();
		resetModelsProjection();
	});

	describe('the adapter signs a decision only when one identified source served it', () => {
		it('adds the source when every inner call reports the same one', async () => {
			configureCalibration({}, false);
			assert.strictEqual((await decideWith(['s1'])).signature, `${BASE};source=s1`);
		});

		it('leaves a decision unsigned when sources differ or one is unknown', async () => {
			configureCalibration({}, false);
			assert.strictEqual((await decideWith(['s1', 's2'])).signature, undefined);
			assert.strictEqual((await decideWith(['s1', undefined])).signature, undefined);
		});

		it('passes no hook and keeps the plain signature while calibration is off', async () => {
			const { signature, seen } = await decideWith(['s1']);
			assert.strictEqual(signature, BASE);
			for (const opts of seen) assert.strictEqual(Object.getOwnPropertySymbols(opts).length, 0);
		});
	});

	describe('the facade reports each successful attempt', () => {
		it('reports the served source outside the attempt, and hides the hook from the backend', async () => {
			let backendOpts;
			const backend = defineBackend({
				name: 'plain',
				generate: async (_input, opts) => {
					backendOpts = opts;
					return { status: 'completed', output: { content: 'ok', finishReason: 'stop' } };
				},
			});
			setGenerative('default', backend);
			const reported = [];
			await models.generate('x', { [SERVED_SOURCE]: (source) => reported.push(source) });
			assert.deepStrictEqual(reported, [undefined], 'a backend registered from code has no identified source');
			assert.strictEqual(backendOpts[SERVED_SOURCE], undefined);
		});

		it('a throwing hook neither fails the call nor tries another backend', async () => {
			let calls = 0;
			setGenerative(
				'default',
				defineBackend({
					name: 'plain',
					generate: async () => {
						calls++;
						return { status: 'completed', output: { content: 'ok', finishReason: 'stop' } };
					},
				})
			);
			const result = await models.generate('x', {
				[SERVED_SOURCE]: () => {
					throw new Error('hook');
				},
			});
			assert.strictEqual(result.content, 'ok');
			assert.strictEqual(calls, 1);
		});
	});

	describe('configured entries carry a fingerprint of their settings', () => {
		const entry = (extra = {}) => ({ backend: FLAKY, answer: '{"value":"bug"}', ...extra });

		it('ignores credentials and the fallback list, and changes with revision or any other setting', () => {
			const base = sourceFingerprint('generative', undefined, { backend: 'openai', model: 'm', apiKey: 'a' });
			assert.strictEqual(
				sourceFingerprint('generative', undefined, { backend: 'openai', model: 'm', apiKey: 'b', fallback: ['x'] }),
				base
			);
			assert.notStrictEqual(
				sourceFingerprint('generative', undefined, { backend: 'openai', model: 'm', apiKey: 'a', revision: 'r2' }),
				base
			);
			assert.notStrictEqual(sourceFingerprint('generative', undefined, { backend: 'openai', model: 'n' }), base);
		});

		it('keeps an entry fingerprint when an unrelated entry is added', async () => {
			await bootstrapModels({ models: { generative: { default: entry() } } });
			const before = getBackendSource(getBackend('generative', 'default'));
			assert.strictEqual(typeof before, 'string');
			resetModelsProjection();
			clearRegistry();
			await bootstrapModels({
				models: { generative: { default: entry(), other: entry({ answer: '{"value":"other"}' }) } },
			});
			assert.strictEqual(getBackendSource(getBackend('generative', 'default')), before);
		});

		it('leaves a vote unsigned when a later sample falls back to another entry of the same provider', async () => {
			await bootstrapModels({
				models: {
					generative: {
						default: entry({ name: 'openai', failFrom: 2, fallback: ['backup'] }),
						backup: entry({ name: 'openai', model: 'another' }),
					},
					decision: { default: { backend: 'generative', samples: 3, concurrency: 1, scoring: 'vote' } },
					calibration: {},
				},
			});
			const d = await models.decide('x', QUEUE, { persist: true });
			assert.strictEqual(d.value, 'bug');
			const record = await models.getDecision(d.id);
			assert.strictEqual(record.signature, undefined, 'mixed sources are never signed');
			assert.strictEqual(record.population, undefined);
		});

		it('signs a vote served by one entry and records its population', async () => {
			await bootstrapModels({
				models: {
					generative: { default: entry() },
					decision: { default: { backend: 'generative', samples: 3, concurrency: 1, scoring: 'vote' } },
					calibration: {},
				},
			});
			const d = await models.decide('x', QUEUE, { persist: true });
			const record = await models.getDecision(d.id);
			assert.match(record.signature, /;source=[0-9a-f]{64}$/);
			assert.strictEqual(typeof record.population, 'string');
			assert.strictEqual(typeof record.entry, 'string');
		});
	});
});
