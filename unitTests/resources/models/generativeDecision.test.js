'use strict';

const assert = require('node:assert');
const { join } = require('node:path');
require('#src/resources/databases');
const {
	createGenerativeDecisionBackend,
	registerGenerativeDecisionBackend,
	GenerativeDecisionError,
	DEFAULT_SAMPLES,
	MAX_SAMPLES,
} = require('#src/resources/models/generativeDecision');
const { bootstrapModels, resetModelsProjection } = require('#src/resources/models/bootstrap');
const {
	clearRegistry,
	defineBackend,
	resolveDecision,
	resolveGenerative,
	setDecision,
	setGenerative,
	ModelBackendNotFoundError,
} = require('#src/resources/models/backendRegistry');
const { clearRouting, getRouter } = require('#src/resources/models/routing');
const { models, Models } = require('#src/resources/models/Models');
const { ChoiceScoringUnsupportedError } = require('#src/resources/models/backendHelpers');
const { OpenAIBackend } = require('#src/components/openai/index');

const QUEUE = { enum: ['billing', 'refund', 'bug', 'other'], description: 'Which queue?' };
const accounting = {};
const close = (actual, expected, label) =>
	assert.ok(Math.abs(actual - expected) < 1e-9, `${label ?? ''} ${actual} ≠ ${expected}`);

/** A fake `models.scoreChoices` that answers log-likelihood arrays from a script, records every call, and honors its signal. */
function scriptedScore(answers, { delayMs = 0 } = {}) {
	const calls = [];
	let i = 0;
	let inFlight = 0;
	let maxInFlight = 0;
	const score = async (input, choices, opts) => {
		calls.push({ input, choices, opts });
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			const answer = answers[i++ % answers.length];
			if (delayMs) {
				await new Promise((resolve, reject) => {
					const timer = setTimeout(resolve, delayMs);
					opts.signal?.addEventListener(
						'abort',
						() => {
							clearTimeout(timer);
							reject(opts.signal.reason ?? new Error('aborted'));
						},
						{ once: true }
					);
				});
			}
			if (answer instanceof Error) throw answer;
			return { logLikelihoods: typeof answer === 'function' ? answer(choices) : answer };
		} finally {
			inFlight--;
		}
	};
	return {
		score,
		calls,
		get maxInFlight() {
			return maxInFlight;
		},
		get inFlight() {
			return inFlight;
		},
	};
}

const neverScore = async () => {
	throw new Error('scoreChoices must not be called');
};
const neverGenerate = async () => {
	throw new Error('generate must not be called');
};

/** A fake `models.generate` that answers from a script, records every call, and honors its signal. */
function scriptedGenerate(answers, { delayMs = 0 } = {}) {
	const calls = [];
	let i = 0;
	let inFlight = 0;
	let maxInFlight = 0;
	const generate = async (input, opts) => {
		calls.push({ input, opts });
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			const answer = answers[i++ % answers.length];
			if (delayMs) {
				await new Promise((resolve, reject) => {
					const timer = setTimeout(resolve, delayMs);
					opts.signal?.addEventListener(
						'abort',
						() => {
							clearTimeout(timer);
							reject(opts.signal.reason ?? new Error('aborted'));
						},
						{ once: true }
					);
				});
			}
			if (answer instanceof Error) throw answer;
			return { content: typeof answer === 'string' ? answer : JSON.stringify(answer), finishReason: 'stop' };
		} finally {
			inFlight--;
		}
	};
	return {
		generate,
		calls,
		get maxInFlight() {
			return maxInFlight;
		},
	};
}

describe('generative decision adapter', () => {
	it('votes over N structured samples and reports frequencies over every allowed value, with no usage', async () => {
		const s = scriptedGenerate([
			{ value: 'refund' },
			{ value: 'refund' },
			{ value: 'bug' },
			{ value: 'refund' },
			{ value: 'billing' },
		]);
		const backend = createGenerativeDecisionBackend({ samples: 5 }, { generate: s.generate });
		assert.strictEqual(backend.name, 'generative');
		assert.deepStrictEqual(backend.capabilities(), {
			embed: false,
			generate: false,
			stream: false,
			tools: false,
			adapters: false,
			decide: true,
			calibrated: false,
		});
		const result = await backend.decide('ticket', QUEUE, { accounting });
		assert.strictEqual(result.status, 'completed');
		assert.strictEqual(result.usage, undefined);
		assert.deepStrictEqual(result.output.distribution, [
			{ value: 'billing', probability: 0.2 },
			{ value: 'refund', probability: 0.6 },
			{ value: 'bug', probability: 0.2 },
			{ value: 'other', probability: 0 },
		]);
		assert.strictEqual(s.calls.length, 5);
	});

	it('passes the strict response schema, the generative logical name, temperature and a signal to every sample', async () => {
		const s = scriptedGenerate([{ value: true }]);
		const backend = createGenerativeDecisionBackend(
			{ generative: 'fast', samples: 2, temperature: 0.7 },
			{ generate: s.generate }
		);
		await backend.decide(
			{ text: 'urgent!' },
			{ type: 'boolean', description: 'Is it urgent?' },
			{ accounting, instructions: 'Be strict.' }
		);
		assert.strictEqual(s.calls.length, 2);
		for (const { opts } of s.calls) {
			assert.strictEqual(opts.model, 'fast');
			assert.strictEqual(opts.temperature, 0.7);
			assert.ok(opts.signal instanceof AbortSignal);
			assert.deepStrictEqual(opts.responseFormat, {
				schema: {
					type: 'object',
					properties: { value: { type: 'boolean', description: 'Is it urgent?' } },
					required: ['value'],
					additionalProperties: false,
				},
			});
		}
		const { input } = s.calls[0];
		assert.strictEqual(typeof input.system, 'string');
		assert.strictEqual(input.messages.length, 1);
		const content = input.messages[0].content;
		assert.ok(content.includes('Be strict.'));
		assert.ok(content.includes('Is it urgent?'));
		assert.ok(content.includes('{"text":"urgent!"}'));
	});

	it('produces per-field marginals for object schemas from joint samples', async () => {
		const s = scriptedGenerate([
			{ queue: 'bug', urgent: true },
			{ queue: 'bug', urgent: false },
			{ queue: 'refund', urgent: true },
		]);
		const backend = createGenerativeDecisionBackend({ samples: 3 }, { generate: s.generate });
		const schema = { type: 'object', properties: { queue: QUEUE, urgent: { type: 'boolean' } } };
		const { output } = await backend.decide('x', schema, { accounting });
		assert.deepStrictEqual(output.fields.urgent.distribution, [
			{ value: false, probability: 1 / 3 },
			{ value: true, probability: 2 / 3 },
		]);
		assert.deepStrictEqual(
			output.fields.queue.distribution.find((e) => e.value === 'bug'),
			{ value: 'bug', probability: 2 / 3 }
		);
		assert.deepStrictEqual(s.calls[0].opts.responseFormat.schema.required, ['queue', 'urgent']);
	});

	it('fails loud on a sample outside the schema, cancelling the samples still in flight after they settle', async () => {
		const s = scriptedGenerate([{ value: 'spam' }, { value: 'bug' }, { value: 'bug' }, { value: 'bug' }], {
			delayMs: 20,
		});
		const backend = createGenerativeDecisionBackend({ samples: 4, concurrency: 4 }, { generate: s.generate });
		await assert.rejects(
			backend.decide('x', QUEUE, { accounting }),
			(err) => err instanceof GenerativeDecisionError && /outside the decision schema/.test(err.message)
		);
		assert.strictEqual(s.calls.length, 4);
		assert.ok(
			s.calls.every(({ opts }) => opts.signal.aborted),
			'the shared signal is aborted for the samples that were in flight'
		);
	});

	it('propagates a generate failure and starts no further samples', async () => {
		const s = scriptedGenerate([new Error('provider down')]);
		const backend = createGenerativeDecisionBackend({ samples: 5, concurrency: 1 }, { generate: s.generate });
		await assert.rejects(backend.decide('x', QUEUE, { accounting }), /provider down/);
		assert.strictEqual(s.calls.length, 1);
	});

	it('honors the caller signal: an already-aborted signal rejects with the abort and calls nothing', async () => {
		const s = scriptedGenerate([{ value: 'bug' }]);
		const backend = createGenerativeDecisionBackend({ samples: 3 }, { generate: s.generate });
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			backend.decide('x', QUEUE, { accounting, signal: controller.signal }),
			(err) => err.name === 'AbortError'
		);
		assert.strictEqual(s.calls.length, 0);
	});

	it('bounds in-flight samples by concurrency and clamps samples/concurrency to the ceiling', async () => {
		const s = scriptedGenerate([{ value: 'bug' }], { delayMs: 5 });
		await createGenerativeDecisionBackend({ samples: 6, concurrency: 2 }, { generate: s.generate }).decide('x', QUEUE, {
			accounting,
		});
		assert.strictEqual(s.calls.length, 6);
		assert.strictEqual(s.maxInFlight, 2);
		const s2 = scriptedGenerate([{ value: 'bug' }]);
		await createGenerativeDecisionBackend({ samples: 999, concurrency: 999 }, { generate: s2.generate }).decide(
			'x',
			QUEUE,
			{
				accounting,
			}
		);
		assert.strictEqual(s2.calls.length, MAX_SAMPLES);
		const s3 = scriptedGenerate([{ value: 'bug' }]);
		await createGenerativeDecisionBackend({ samples: 0 }, { generate: s3.generate }).decide('x', QUEUE, { accounting });
		assert.strictEqual(s3.calls.length, DEFAULT_SAMPLES);
	});

	it('applies requestTimeoutMs as a budget for the whole decision', async () => {
		const s = scriptedGenerate([{ value: 'bug' }], { delayMs: 200 });
		const backend = createGenerativeDecisionBackend({ samples: 2, requestTimeoutMs: 20 }, { generate: s.generate });
		await assert.rejects(
			backend.decide('x', QUEUE, { accounting }),
			(err) => err.name === 'TimeoutError' || err.name === 'AbortError'
		);
	});

	it('refuses to register under a kind other than decision', () => {
		assert.throws(
			() => registerGenerativeDecisionBackend({ logicalName: 'x', kind: 'generative', config: {} }),
			GenerativeDecisionError
		);
	});
});

describe('generative decision adapter — likelihood scoring (#2838)', () => {
	const canScore = () => true;

	it('scores every allowed value in one call and normalizes the log-likelihoods, with no usage', async () => {
		const s = scriptedScore([[Math.log(0.6), Math.log(0.1), Math.log(0.2), Math.log(0.1)]]);
		const backend = createGenerativeDecisionBackend(
			{ generative: 'fast', scoring: 'score' },
			{ generate: neverGenerate, score: s.score, canScore }
		);
		const result = await backend.decide('ticket', QUEUE, { accounting, instructions: 'Be strict.' });
		assert.strictEqual(result.status, 'completed');
		assert.strictEqual(result.usage, undefined);
		const { distribution } = result.output;
		assert.deepStrictEqual(
			distribution.map((o) => o.value),
			QUEUE.enum
		);
		close(distribution[0].probability, 0.6, 'billing');
		close(distribution[1].probability, 0.1, 'refund');
		close(distribution[2].probability, 0.2, 'bug');
		close(distribution[3].probability, 0.1, 'other');
		assert.strictEqual(s.calls.length, 1);
		const [{ input, choices, opts }] = s.calls;
		assert.deepStrictEqual(choices, QUEUE.enum);
		assert.strictEqual(opts.model, 'fast');
		assert.ok(opts.signal instanceof AbortSignal);
		assert.strictEqual(typeof input.system, 'string');
		assert.ok(!input.system.includes('JSON'), 'the scoring prompt does not ask for JSON');
		const content = input.messages[0].content;
		assert.ok(content.includes('Be strict.'));
		assert.ok(content.includes('Which queue?'));
		assert.ok(content.includes('Decide "value"'));
		assert.ok(content.includes('ticket'));
	});

	it('stringifies boolean and integer choices and maps the scores back to typed values', async () => {
		const s = scriptedScore([(choices) => choices.map((_, i) => i)]);
		const backend = createGenerativeDecisionBackend(
			{ scoring: 'score' },
			{ generate: neverGenerate, score: s.score, canScore }
		);
		const bool = await backend.decide('x', { type: 'boolean' }, { accounting });
		assert.deepStrictEqual(s.calls[0].choices, ['false', 'true']);
		assert.deepStrictEqual(
			bool.output.distribution.map((o) => o.value),
			[false, true]
		);
		assert.ok(bool.output.distribution[1].probability > bool.output.distribution[0].probability);
		const range = await backend.decide('x', { type: 'integer', minimum: 1, maximum: 3 }, { accounting });
		assert.deepStrictEqual(s.calls[1].choices, ['1', '2', '3']);
		assert.deepStrictEqual(
			range.output.distribution.map((o) => o.value),
			[1, 2, 3]
		);
	});

	it('scores an object schema one field per call under the concurrency bound, with per-field marginals', async () => {
		const properties = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`f${i}`, { type: 'boolean' }]));
		const s = scriptedScore([[0, 1]], { delayMs: 2 });
		const backend = createGenerativeDecisionBackend(
			{ scoring: 'score', concurrency: 3 },
			{ generate: neverGenerate, score: s.score, canScore }
		);
		const result = await backend.decide({ a: 1 }, { type: 'object', properties }, { accounting });
		assert.strictEqual(s.calls.length, 32);
		assert.ok(s.maxInFlight <= 3, `max in flight ${s.maxInFlight}`);
		assert.deepStrictEqual(Object.keys(result.output.fields), Object.keys(properties));
		for (const [name, field] of Object.entries(result.output.fields)) {
			assert.deepStrictEqual(
				field.distribution.map((o) => o.value),
				[false, true]
			);
			close(field.distribution[1].probability, Math.exp(1) / (1 + Math.exp(1)), name);
		}
		// Each call names only its own field.
		const first = s.calls.find((c) => c.input.messages[0].content.includes('Decide "f7"'));
		assert.ok(first);
		assert.ok(!first.input.messages[0].content.includes('"f8"'));
	});

	it('auto votes without a scoring attempt when the generative name cannot score', async () => {
		const g = scriptedGenerate([{ value: 'bug' }]);
		const backend = createGenerativeDecisionBackend(
			{ samples: 2 },
			{ generate: g.generate, score: neverScore, canScore: () => false }
		);
		const result = await backend.decide('x', QUEUE, { accounting });
		assert.strictEqual(result.output.distribution[2].probability, 1);
		assert.strictEqual(g.calls.length, 2);
	});

	it('auto falls back to voting when the backend declines a call, discarding any field already scored', async () => {
		const schema = { type: 'object', properties: { p: { type: 'boolean' }, q: { type: 'boolean' } } };
		const s = scriptedScore([[0, 1], new ChoiceScoringUnsupportedError('declined')]);
		const g = scriptedGenerate([{ p: true, q: false }]);
		const backend = createGenerativeDecisionBackend(
			{ samples: 3, concurrency: 1 },
			{ generate: g.generate, score: s.score, canScore }
		);
		const result = await backend.decide('x', schema, { accounting });
		assert.strictEqual(s.calls.length, 2);
		assert.strictEqual(g.calls.length, 3);
		assert.deepStrictEqual(result.output.fields.p.distribution, [
			{ value: false, probability: 0 },
			{ value: true, probability: 1 },
		]);
		assert.deepStrictEqual(result.output.fields.q.distribution, [
			{ value: false, probability: 1 },
			{ value: true, probability: 0 },
		]);
	});

	it('auto also votes after a ModelCapabilityError, the backend having lost the hook since the probe', async () => {
		const s = scriptedScore([Object.assign(new Error('no longer'), { name: 'ModelCapabilityError' })]);
		const g = scriptedGenerate([{ value: 'other' }]);
		const backend = createGenerativeDecisionBackend({ samples: 1 }, { generate: g.generate, score: s.score, canScore });
		const result = await backend.decide('x', QUEUE, { accounting });
		assert.strictEqual(result.output.distribution[3].probability, 1);
	});

	it('auto rethrows any other scoring failure without voting', async () => {
		const s = scriptedScore([new Error('provider down')]);
		const backend = createGenerativeDecisionBackend({}, { generate: neverGenerate, score: s.score, canScore });
		await assert.rejects(backend.decide('x', QUEUE, { accounting }), /provider down/);
	});

	it('score never votes: an unsupported call fails the decision', async () => {
		const s = scriptedScore([new ChoiceScoringUnsupportedError('declined')]);
		const backend = createGenerativeDecisionBackend(
			{ scoring: 'score' },
			{ generate: neverGenerate, score: s.score, canScore: () => false }
		);
		await assert.rejects(backend.decide('x', QUEUE, { accounting }), ChoiceScoringUnsupportedError);
	});

	it('vote never scores', async () => {
		const g = scriptedGenerate([{ value: 'bug' }]);
		const backend = createGenerativeDecisionBackend(
			{ scoring: 'vote', samples: 1 },
			{ generate: g.generate, score: neverScore, canScore }
		);
		const result = await backend.decide('x', QUEUE, { accounting });
		assert.strictEqual(result.output.distribution[2].probability, 1);
	});

	it('rejects a score vector of the wrong length or with non-finite entries', async () => {
		for (const answer of [[0, 1], [0, 1, 2, 3, 4], [0, NaN, 0, 0], [0, Infinity, 0, 0], ['0', 0, 0, 0], null]) {
			const s = scriptedScore([answer]);
			const backend = createGenerativeDecisionBackend(
				{ scoring: 'score' },
				{ generate: neverGenerate, score: s.score, canScore }
			);
			await assert.rejects(
				backend.decide('x', QUEUE, { accounting }),
				(err) =>
					err instanceof GenerativeDecisionError &&
					/one finite log-likelihood per allowed value \(4\)/.test(err.message),
				JSON.stringify(answer)
			);
		}
	});

	it('a caller abort during scoring settles every in-flight call before rejecting', async () => {
		const properties = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`f${i}`, { type: 'boolean' }]));
		const s = scriptedScore([[0, 1]], { delayMs: 200 });
		const backend = createGenerativeDecisionBackend(
			{ scoring: 'score', concurrency: 4 },
			{ generate: neverGenerate, score: s.score, canScore }
		);
		const controller = new AbortController();
		const pending = backend.decide('x', { type: 'object', properties }, { accounting, signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.strictEqual(s.inFlight, 4);
		controller.abort();
		await assert.rejects(pending, { name: 'AbortError' });
		assert.strictEqual(s.inFlight, 0);
		assert.ok(s.calls.every((c) => c.opts.signal.aborted));
	});

	it('applies requestTimeoutMs to scoring as the budget for the whole decision', async () => {
		const s = scriptedScore([[0, 1, 2, 3]], { delayMs: 200 });
		const backend = createGenerativeDecisionBackend(
			{ scoring: 'score', requestTimeoutMs: 20 },
			{ generate: neverGenerate, score: s.score, canScore }
		);
		await assert.rejects(
			backend.decide('x', QUEUE, { accounting }),
			(err) => err.name === 'TimeoutError' || err.name === 'AbortError'
		);
	});
});

describe('generative decision adapter — auto over an OpenAI model that rejects logprobs (through the facade)', () => {
	const json = (body, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
	const refused = () =>
		json(
			{
				error: {
					message: "'logprobs' is not supported with this model.",
					param: 'logprobs',
					code: 'unsupported_parameter',
				},
			},
			400
		);
	const completion = (content) =>
		json({
			choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 5, completion_tokens: 2 },
		});

	beforeEach(() => {
		clearRegistry();
		clearRouting();
	});

	afterEach(() => {
		clearRegistry();
		clearRouting();
	});

	it('pays one declined attempt, then votes on every later decision without a scoring attempt or row', async () => {
		const bodies = [];
		const fetch = async (_url, init) => {
			const body = JSON.parse(init.body);
			bodies.push(body);
			return body.logprobs ? refused() : completion('{"value":"bug"}');
		};
		const writer = { records: [], write: (record) => writer.records.push(record) };
		const facade = new Models(writer, () => {});
		setGenerative('default', new OpenAIBackend({ apiKey: 'sk-test', model: 'o-reasoning' }, fetch));
		setDecision(
			'default',
			createGenerativeDecisionBackend(
				{ samples: 1 },
				{
					generate: (input, opts) => facade.generate(input, opts),
					score: (i, c, opts) => facade.scoreChoices(i, c, opts),
				}
			)
		);
		assert.strictEqual((await facade.decide('x', QUEUE)).value, 'bug');
		assert.deepStrictEqual(
			writer.records.map((row) => [row.method, row.success, row.error_code]),
			[
				['scoreChoices', false, 'scoring_unsupported'],
				['generate', true, undefined],
				['decide', true, undefined],
			]
		);
		writer.records.length = 0;
		bodies.length = 0;
		assert.strictEqual((await facade.decide('x', QUEUE)).value, 'bug');
		assert.deepStrictEqual(
			writer.records.map((row) => row.method),
			['generate', 'decide']
		);
		assert.ok(bodies.every((body) => body.logprobs === undefined));
	});
});

describe('generative decision adapter — a declined call’s tokens are billed once (through the facade)', () => {
	const schema = {
		type: 'object',
		properties: { p: { type: 'boolean' }, q: { type: 'boolean' }, r: { type: 'boolean' } },
	};
	let writer;
	let metrics;
	let facade;

	/** Declines the first call with usage; every other call waits until its signal aborts. */
	function decliningScorer() {
		let calls = 0;
		return defineBackend({
			name: 'declines',
			generate: async () => ({
				status: 'completed',
				output: { content: '{"p":true,"q":false,"r":true}', finishReason: 'stop' },
			}),
			scoreChoices: (_input, _choices, opts) =>
				new Promise((_resolve, reject) => {
					if (calls++ === 0)
						return reject(new ChoiceScoringUnsupportedError('declined', { promptTokens: 40, completionTokens: 1 }));
					opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
				}),
		});
	}

	beforeEach(() => {
		clearRegistry();
		clearRouting();
		writer = { records: [], write: (record) => writer.records.push(record) };
		metrics = [];
		facade = new Models(writer, (value, metric, path) => metrics.push({ value, metric, path }));
		setGenerative('default', decliningScorer());
	});

	afterEach(() => {
		clearRegistry();
		clearRouting();
	});

	const adapter = (config) =>
		createGenerativeDecisionBackend(config, {
			generate: (input, opts) => facade.generate(input, opts),
			score: (input, choices, opts) => facade.scoreChoices(input, choices, opts),
		});

	it('auto: siblings cut short by the decline are recorded as aborted without its usage, then the vote runs', async () => {
		setDecision('default', adapter({ samples: 1, concurrency: 3 }));
		const d = await facade.decide('x', schema);
		assert.strictEqual(d.fields.p.value, true);
		const scoring = writer.records.filter((row) => row.method === 'scoreChoices');
		assert.deepStrictEqual(scoring.map((row) => [row.error_code, row.prompt_tokens]).sort(), [
			['aborted', undefined],
			['aborted', undefined],
			['scoring_unsupported', 40],
		]);
		assert.deepStrictEqual(
			writer.records
				.filter((row) => row.method !== 'scoreChoices')
				.map((row) => [row.method, row.success, row.prompt_tokens]),
			[
				['generate', true, undefined],
				['decide', true, undefined],
			]
		);
		assert.deepStrictEqual(
			metrics.filter((m) => m.metric.endsWith('-tokens')),
			[{ value: 41, metric: 'model-scoreChoices-tokens', path: 'declines' }]
		);
	});

	it('score: the decision fails and the decide failure row carries none of the decline’s usage', async () => {
		setDecision('default', adapter({ scoring: 'score', concurrency: 1 }));
		await assert.rejects(facade.decide('x', schema), ChoiceScoringUnsupportedError);
		const decide = writer.records.find((row) => row.method === 'decide');
		assert.strictEqual(decide.success, false);
		assert.strictEqual(decide.error_code, 'scoring_unsupported');
		assert.strictEqual(decide.prompt_tokens, undefined);
		assert.deepStrictEqual(
			metrics.filter((m) => m.metric.endsWith('-tokens')),
			[{ value: 41, metric: 'model-scoreChoices-tokens', path: 'declines' }]
		);
	});
});

describe('models.decision config → generative adapter → facade (through bootstrap)', () => {
	const FIXTURE = join(__dirname, 'fixtures', 'json-generative-module.cjs');
	const generativeEntry = (answers) => ({ backend: FIXTURE, answers });

	beforeEach(() => {
		clearRegistry();
		clearRouting();
		resetModelsProjection();
	});

	afterEach(() => {
		clearRegistry();
		clearRouting();
		resetModelsProjection();
	});

	it('boots a generative module plus a decision entry, and models.decide votes through the singleton', async () => {
		await bootstrapModels({
			models: {
				generative: { default: generativeEntry(['{"value":"bug"}', '{"value":"bug"}', '{"value":"refund"}']) },
				decision: { default: { backend: 'generative', samples: 3, concurrency: 1 } },
			},
		});
		assert.strictEqual(resolveDecision('default').name, 'generative');
		const d = await models.decide('crash on save', QUEUE);
		assert.strictEqual(d.value, 'bug');
		assert.ok(Math.abs(d.probability - 2 / 3) < 1e-9);
		assert.strictEqual(d.distribution.length, 4);
		assert.strictEqual(d.calibrated, false);
		assert.strictEqual(typeof d.id, 'string');
		assert.strictEqual(d.usage, undefined);
	});

	it('resolves the generative logical name at call time, so a re-bootstrapped generative entry is picked up', async () => {
		const decision = { default: { backend: 'generative', samples: 1 } };
		await bootstrapModels({ models: { generative: { default: generativeEntry(['{"value":"bug"}']) }, decision } });
		assert.strictEqual((await models.decide('x', QUEUE)).value, 'bug');
		await bootstrapModels({ models: { generative: { default: generativeEntry(['{"value":"other"}']) }, decision } });
		assert.strictEqual((await models.decide('x', QUEUE)).value, 'other');
	});

	it('records a decision fallback group like the other kinds', async () => {
		await bootstrapModels({
			models: {
				generative: { default: generativeEntry(['{"value":"bug"}']) },
				decision: {
					default: { backend: 'generative', samples: 1, fallback: ['alt'] },
					alt: { backend: 'generative', samples: 1 },
				},
			},
		});
		const candidates = getRouter().route({ kind: 'decision', logicalName: 'default', requires: ['decide'] });
		assert.deepStrictEqual(candidates, [resolveDecision('default'), resolveDecision('alt')]);
	});

	it('refuses a provider backend under models.decision and the adapter under models.generative', async () => {
		await bootstrapModels({
			models: {
				decision: { default: { backend: 'ollama', model: 'llama3.2' } },
				generative: { default: { backend: 'generative' } },
			},
		});
		assert.throws(() => resolveDecision('default'), ModelBackendNotFoundError);
		assert.throws(() => resolveGenerative('default'), ModelBackendNotFoundError);
	});

	it('surfaces a missing generative logical name as that kind’s not-found error through decide', async () => {
		await bootstrapModels({
			models: { decision: { default: { backend: 'generative', generative: 'missing', samples: 1 } } },
		});
		await assert.rejects(
			models.decide('x', QUEUE),
			(err) => err instanceof ModelBackendNotFoundError && /generative\.missing/.test(err.message)
		);
	});
});

describe('models.decision config → likelihood scoring → facade (through bootstrap, #2838)', () => {
	const FIXTURE = join(__dirname, 'fixtures', 'scoring-generative-module.cjs');
	const fixtureCalls = () => require(FIXTURE).calls;

	beforeEach(() => {
		clearRegistry();
		clearRouting();
		resetModelsProjection();
		fixtureCalls().length = 0;
	});

	afterEach(() => {
		clearRegistry();
		clearRouting();
		resetModelsProjection();
	});

	it('auto scores through the singleton when the generative module implements scoreChoices', async () => {
		await bootstrapModels({
			models: {
				generative: { default: { backend: FIXTURE, scores: [[0, 0, 2, 0]] } },
				decision: { default: { backend: 'generative', samples: 3 } },
			},
		});
		const d = await models.decide('crash on save', QUEUE);
		assert.strictEqual(d.value, 'bug');
		close(d.probability, Math.exp(2) / (3 + Math.exp(2)));
		assert.strictEqual(d.distribution.length, 4);
		assert.strictEqual(d.calibrated, false);
		assert.strictEqual(d.usage, undefined);
		assert.strictEqual(typeof d.id, 'string');
		assert.deepStrictEqual(
			fixtureCalls().map((c) => c.method),
			['scoreChoices']
		);
		assert.deepStrictEqual(fixtureCalls()[0].choices, QUEUE.enum);
	});

	it('auto votes when the generative module has no scoreChoices, without a scoring attempt', async () => {
		await bootstrapModels({
			models: {
				generative: { default: { backend: FIXTURE, scoreless: true, answers: ['{"value":"refund"}'] } },
				decision: { default: { backend: 'generative', samples: 2 } },
			},
		});
		const d = await models.decide('x', QUEUE);
		assert.strictEqual(d.value, 'refund');
		assert.strictEqual(d.probability, 1);
		assert.deepStrictEqual(
			fixtureCalls().map((c) => c.method),
			['generate', 'generate']
		);
	});

	it('auto votes after the module declines, and score surfaces the refusal', async () => {
		await bootstrapModels({
			models: {
				generative: { default: { backend: FIXTURE, unsupported: true, answers: ['{"value":"other"}'] } },
				decision: {
					default: { backend: 'generative', samples: 1 },
					strict: { backend: 'generative', scoring: 'score' },
				},
			},
		});
		assert.strictEqual((await models.decide('x', QUEUE)).value, 'other');
		assert.deepStrictEqual(
			fixtureCalls().map((c) => c.method),
			['scoreChoices', 'generate']
		);
		await assert.rejects(models.decide('x', QUEUE, { model: 'strict' }), ChoiceScoringUnsupportedError);
	});

	it('vote never scores, even against a scoring module', async () => {
		await bootstrapModels({
			models: {
				generative: { default: { backend: FIXTURE, scores: [[0, 0, 2, 0]], answers: ['{"value":"billing"}'] } },
				decision: { default: { backend: 'generative', scoring: 'vote', samples: 1 } },
			},
		});
		assert.strictEqual((await models.decide('x', QUEUE)).value, 'billing');
		assert.deepStrictEqual(
			fixtureCalls().map((c) => c.method),
			['generate']
		);
	});

	it('a reload that swaps the generative module changes the path on the next decision', async () => {
		const decision = { default: { backend: 'generative', samples: 1 } };
		await bootstrapModels({
			models: { generative: { default: { backend: FIXTURE, scores: [[0, 0, 2, 0]] } }, decision },
		});
		assert.strictEqual((await models.decide('x', QUEUE)).value, 'bug');
		await bootstrapModels({
			models: {
				generative: { default: { backend: FIXTURE, scoreless: true, answers: ['{"value":"other"}'] } },
				decision,
			},
		});
		assert.strictEqual((await models.decide('x', QUEUE)).value, 'other');
		assert.deepStrictEqual(
			fixtureCalls().map((c) => c.method),
			['scoreChoices', 'generate']
		);
	});
});

describe('models.decision config → module decision backend (through bootstrap)', () => {
	const FIXTURE = join(__dirname, 'fixtures', 'decision-backend-module.cjs');

	beforeEach(() => {
		clearRegistry();
		clearRouting();
		resetModelsProjection();
	});

	afterEach(() => {
		clearRegistry();
		clearRouting();
		resetModelsProjection();
	});

	it('boots a decision backend from a module specifier under models.decision and decides through the singleton', async () => {
		await bootstrapModels({
			models: {
				decision: {
					default: { backend: FIXTURE, winner: 'other', calibrated: true, fallback: ['llm'] },
					llm: { backend: 'generative', samples: 1 },
				},
			},
		});
		assert.strictEqual(resolveDecision('default').name, 'module:decision-default');
		const d = await models.decide({ body: 'hello' }, QUEUE, { requires: ['calibrated'] });
		assert.strictEqual(d.value, 'other');
		assert.strictEqual(d.probability, 1);
		assert.strictEqual(d.calibrated, true);
		assert.deepStrictEqual(d.usage, { promptTokens: 3 });
		const candidates = getRouter().route({ kind: 'decision', logicalName: 'default', requires: ['decide'] });
		assert.deepStrictEqual(candidates, [resolveDecision('default'), resolveDecision('llm')]);
	});
});
