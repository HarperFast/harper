'use strict';

const assert = require('node:assert');
require('#src/resources/databases');
const { setGenerative, clearRegistry, defineBackend } = require('#src/resources/models/backendRegistry');
const { ModelBackendNotFoundError } = require('#src/resources/models/backendRegistry');
const { clearRouting, setFallbackGroup } = require('#src/resources/models/routing');
const { TestBackend } = require('#src/resources/models/TestBackend');
const { Models, ModelCapabilityError } = require('#src/resources/models/Models');
const { ChoiceScoringUnsupportedError } = require('#src/resources/models/backendHelpers');

const CHOICES = ['a', 'b', 'c'];
const generate = async () => ({ status: 'completed', output: { content: '', finishReason: 'stop' } });

function makeMockWriter() {
	const records = [];
	let nextId = 1000;
	return {
		records,
		write(record) {
			records.push(record);
			return nextId++;
		},
	};
}

function makeMetricSpy() {
	const calls = [];
	return { calls, emitter: (value, metric, path) => calls.push({ value, metric, path }) };
}

/** A generative backend whose scoreChoices results are scripted per call; an Error entry is thrown. */
function scorer(name, outputs) {
	let i = 0;
	return defineBackend({
		name,
		generate,
		structuredOutput: true,
		scoreChoices: async () => {
			const next = outputs[Math.min(i++, outputs.length - 1)];
			if (next instanceof Error) throw next;
			return next;
		},
	});
}

describe('models.scoreChoices (internal, #2838)', () => {
	let writer;
	let metricSpy;
	let models;

	beforeEach(() => {
		clearRegistry();
		clearRouting();
		writer = makeMockWriter();
		metricSpy = makeMetricSpy();
		models = new Models(writer, metricSpy.emitter);
		setGenerative('default', new TestBackend());
	});

	afterEach(() => {
		clearRegistry();
		clearRouting();
	});

	it('returns the backend’s log-likelihoods with its usage, recording a scoreChoices row and metrics', async () => {
		const r = await models.scoreChoices('ticket', CHOICES);
		assert.strictEqual(r.logLikelihoods.length, 3);
		assert.ok(r.logLikelihoods.every(Number.isFinite));
		assert.deepStrictEqual(r.usage, { promptTokens: 6, latencyMs: 0 });
		assert.strictEqual(writer.records.length, 1);
		const [row] = writer.records;
		assert.strictEqual(row.method, 'scoreChoices');
		assert.strictEqual(row.backend, 'test');
		assert.strictEqual(row.success, true);
		assert.strictEqual(row.prompt_tokens, 6);
		assert.strictEqual(row.error_code, undefined);
		assert.deepStrictEqual(metricSpy.calls, [
			{ value: 1, metric: 'model-scoreChoices', path: 'test' },
			{ value: 6, metric: 'model-scoreChoices-tokens', path: 'test' },
		]);
	});

	it('omits usage when the backend reports none', async () => {
		setGenerative('bare', scorer('bare', [{ status: 'completed', output: { logLikelihoods: [0, 1, 2] } }]));
		const r = await models.scoreChoices('t', CHOICES, { model: 'bare' });
		assert.deepStrictEqual(r, { logLikelihoods: [0, 1, 2] });
		assert.deepStrictEqual(metricSpy.calls, [{ value: 1, metric: 'model-scoreChoices', path: 'bare' }]);
	});

	it('hands the backend the choices and the caller’s signal, never the logical name', async () => {
		let seen;
		setGenerative(
			'spy',
			defineBackend({
				name: 'spy',
				generate,
				structuredOutput: true,
				scoreChoices: async (input, choices, opts) => {
					seen = { input, choices, opts };
					return { status: 'completed', output: { logLikelihoods: choices.map(() => 0) } };
				},
			})
		);
		const signal = new AbortController().signal;
		await models.scoreChoices('ticket', CHOICES, { model: 'spy', signal });
		assert.strictEqual(seen.input, 'ticket');
		assert.deepStrictEqual(seen.choices, CHOICES);
		assert.strictEqual(seen.opts.signal, signal);
		assert.strictEqual(seen.opts.model, undefined);
		assert.ok(seen.opts.accounting);
	});

	it('throws ModelCapabilityError for a generative backend without the hook, recording capability_unsupported', async () => {
		setGenerative('plain', defineBackend({ name: 'plain', generate, structuredOutput: true }));
		await assert.rejects(models.scoreChoices('t', CHOICES, { model: 'plain' }), ModelCapabilityError);
		const [row] = writer.records;
		assert.strictEqual(row.method, 'scoreChoices');
		assert.strictEqual(row.backend, 'plain');
		assert.strictEqual(row.success, false);
		assert.strictEqual(row.error_code, 'capability_unsupported');
		assert.deepStrictEqual(metricSpy.calls, []);
	});

	it('throws ModelBackendNotFoundError for an unknown logical name, recording backend_not_found', async () => {
		await assert.rejects(models.scoreChoices('t', CHOICES, { model: 'missing' }), ModelBackendNotFoundError);
		assert.strictEqual(writer.records[0].error_code, 'backend_not_found');
	});

	it('records an unsupported call as scoring_unsupported with the usage it consumed, and surfaces the error', async () => {
		setGenerative(
			'declines',
			scorer('declines', [new ChoiceScoringUnsupportedError('declined', { promptTokens: 40, completionTokens: 1 })])
		);
		await assert.rejects(
			models.scoreChoices('t', CHOICES, { model: 'declines' }),
			(err) => err instanceof ChoiceScoringUnsupportedError && err.message === 'declined'
		);
		assert.strictEqual(writer.records.length, 1);
		const [row] = writer.records;
		assert.strictEqual(row.success, false);
		assert.strictEqual(row.error_code, 'scoring_unsupported');
		assert.strictEqual(row.prompt_tokens, 40);
		assert.strictEqual(row.completion_tokens, 1);
		assert.deepStrictEqual(metricSpy.calls, [{ value: 41, metric: 'model-scoreChoices-tokens', path: 'declines' }]);
	});

	it('keeps only finite, non-negative integer counts from a failure’s usage', async () => {
		setGenerative(
			'odd',
			scorer('odd', [
				new ChoiceScoringUnsupportedError('declined', { promptTokens: NaN, completionTokens: 3, gpuMs: 5 }),
			])
		);
		await assert.rejects(models.scoreChoices('t', CHOICES, { model: 'odd' }), ChoiceScoringUnsupportedError);
		const [row] = writer.records;
		assert.strictEqual(row.prompt_tokens, undefined);
		assert.strictEqual(row.completion_tokens, 3);
		assert.deepStrictEqual(metricSpy.calls, [{ value: 3, metric: 'model-scoreChoices-tokens', path: 'odd' }]);
	});

	it('does not read usage off an ordinary backend error, only off a decline', async () => {
		setGenerative('down', scorer('down', [Object.assign(new Error('provider down'), { usage: { promptTokens: 9 } })]));
		await assert.rejects(models.scoreChoices('t', CHOICES, { model: 'down' }), /provider down/);
		const [row] = writer.records;
		assert.strictEqual(row.error_code, 'backend_error');
		assert.strictEqual(row.prompt_tokens, undefined);
		assert.deepStrictEqual(metricSpy.calls, []);
	});

	it('records a malformed score vector as one failed attempt, before any success row, and tries the next candidate', async () => {
		for (const output of [
			undefined,
			{ logLikelihoods: [0, 1] },
			{ logLikelihoods: [0, NaN, 1] },
			{ logLikelihoods: '0,1,2' },
		]) {
			clearRegistry();
			clearRouting();
			writer.records.length = 0;
			metricSpy.calls.length = 0;
			setGenerative('bad', scorer('bad', [{ status: 'completed', output }]));
			setGenerative('good', scorer('good', [{ status: 'completed', output: { logLikelihoods: [0, 1, 2] } }]));
			setFallbackGroup('generative', 'bad', ['good']);
			const r = await models.scoreChoices('t', CHOICES, { model: 'bad' });
			assert.deepStrictEqual(r.logLikelihoods, [0, 1, 2]);
			assert.deepStrictEqual(
				writer.records.map((row) => [row.backend, row.success, row.error_code]),
				[
					['bad', false, 'backend_error'],
					['good', true, undefined],
				],
				JSON.stringify(output)
			);
			assert.deepStrictEqual(metricSpy.calls, [{ value: 1, metric: 'model-scoreChoices', path: 'good' }]);
		}
		clearRegistry();
		clearRouting();
		setGenerative('bad', scorer('bad', [{ status: 'completed', output: { logLikelihoods: [0, 1] } }]));
		await assert.rejects(
			models.scoreChoices('t', CHOICES, { model: 'bad' }),
			/did not return one finite log-likelihood per choice \(3\)/
		);
	});

	it('tries the fallback group when the primary declines, and surfaces the primary decline only when every candidate declined', async () => {
		setGenerative('p', scorer('p', [new ChoiceScoringUnsupportedError('p declined')]));
		setGenerative(
			'q',
			scorer('q', [
				{ status: 'completed', output: { logLikelihoods: [0, 1, 2] } },
				new ChoiceScoringUnsupportedError('q declined'),
			])
		);
		setFallbackGroup('generative', 'p', ['q']);
		const r = await models.scoreChoices('t', CHOICES, { model: 'p' });
		assert.deepStrictEqual(r.logLikelihoods, [0, 1, 2]);
		assert.deepStrictEqual(
			writer.records.map((row) => [row.backend, row.success, row.error_code]),
			[
				['p', false, 'scoring_unsupported'],
				['q', true, undefined],
			]
		);
		await assert.rejects(models.scoreChoices('t', CHOICES, { model: 'p' }), /p declined/);
	});

	it('surfaces a fallback failure over a primary decline, so a decline never hides a broken candidate', async () => {
		setGenerative('p', scorer('p', [new ChoiceScoringUnsupportedError('p declined')]));
		setGenerative('q', scorer('q', [Object.assign(new Error('q rate limited'), { upstreamStatus: 429 })]));
		setFallbackGroup('generative', 'p', ['q']);
		await assert.rejects(models.scoreChoices('t', CHOICES, { model: 'p' }), /q rate limited/);
		clearRegistry();
		clearRouting();
		setGenerative('p', scorer('p', [new Error('p down')]));
		setGenerative('q', scorer('q', [new ChoiceScoringUnsupportedError('q declined')]));
		setFallbackGroup('generative', 'p', ['q']);
		await assert.rejects(models.scoreChoices('t', CHOICES, { model: 'p' }), /p down/);
	});

	it('only routes to candidates that score: a fallback without the hook is skipped', async () => {
		setGenerative('p', scorer('p', [new ChoiceScoringUnsupportedError('p declined')]));
		setGenerative('plain', defineBackend({ name: 'plain', generate, structuredOutput: true }));
		setFallbackGroup('generative', 'p', ['plain']);
		await assert.rejects(models.scoreChoices('t', CHOICES, { model: 'p' }), /p declined/);
		assert.deepStrictEqual(
			writer.records.map((row) => row.backend),
			['p']
		);
	});

	it('treats a backend that advertises scoreChoices without implementing it as that backend’s failure', async () => {
		setGenerative('liar', {
			name: 'liar',
			capabilities: () => ({
				embed: false,
				generate: true,
				stream: false,
				tools: false,
				adapters: false,
				scoreChoices: true,
			}),
			generate,
		});
		await assert.rejects(
			models.scoreChoices('t', CHOICES, { model: 'liar' }),
			/advertises 'scoreChoices' but does not implement it/
		);
		assert.strictEqual(writer.records[0].error_code, 'backend_error');
	});

	it('rejects a pending result with one failure row', async () => {
		setGenerative('slow', scorer('slow', [{ status: 'pending', operationId: 'op-1' }]));
		await assert.rejects(models.scoreChoices('t', CHOICES, { model: 'slow' }), /returned 'pending'/);
		assert.strictEqual(writer.records.length, 1);
		assert.strictEqual(writer.records[0].error_code, 'pending_unsupported');
	});

	it('does not call a backend on an already-aborted signal', async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(models.scoreChoices('t', CHOICES, { signal: controller.signal }), { name: 'AbortError' });
		assert.strictEqual(writer.records.length, 0);
	});
});
