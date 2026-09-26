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
	resolveDecision,
	resolveGenerative,
	ModelBackendNotFoundError,
} = require('#src/resources/models/backendRegistry');
const { clearRouting, getRouter } = require('#src/resources/models/routing');
const { models } = require('#src/resources/models/Models');

const QUEUE = { enum: ['billing', 'refund', 'bug', 'other'], description: 'Which queue?' };
const accounting = {};

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
		const backend = createGenerativeDecisionBackend({ samples: 5 }, s.generate);
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
		const backend = createGenerativeDecisionBackend({ generative: 'fast', samples: 2, temperature: 0.7 }, s.generate);
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
		const backend = createGenerativeDecisionBackend({ samples: 3 }, s.generate);
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
		const backend = createGenerativeDecisionBackend({ samples: 4, concurrency: 4 }, s.generate);
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
		const backend = createGenerativeDecisionBackend({ samples: 5, concurrency: 1 }, s.generate);
		await assert.rejects(backend.decide('x', QUEUE, { accounting }), /provider down/);
		assert.strictEqual(s.calls.length, 1);
	});

	it('honors the caller signal: an already-aborted signal rejects with the abort and calls nothing', async () => {
		const s = scriptedGenerate([{ value: 'bug' }]);
		const backend = createGenerativeDecisionBackend({ samples: 3 }, s.generate);
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
		await createGenerativeDecisionBackend({ samples: 6, concurrency: 2 }, s.generate).decide('x', QUEUE, {
			accounting,
		});
		assert.strictEqual(s.calls.length, 6);
		assert.strictEqual(s.maxInFlight, 2);
		const s2 = scriptedGenerate([{ value: 'bug' }]);
		await createGenerativeDecisionBackend({ samples: 999, concurrency: 999 }, s2.generate).decide('x', QUEUE, {
			accounting,
		});
		assert.strictEqual(s2.calls.length, MAX_SAMPLES);
		const s3 = scriptedGenerate([{ value: 'bug' }]);
		await createGenerativeDecisionBackend({ samples: 0 }, s3.generate).decide('x', QUEUE, { accounting });
		assert.strictEqual(s3.calls.length, DEFAULT_SAMPLES);
	});

	it('applies requestTimeoutMs as a budget for the whole decision', async () => {
		const s = scriptedGenerate([{ value: 'bug' }], { delayMs: 200 });
		const backend = createGenerativeDecisionBackend({ samples: 2, requestTimeoutMs: 20 }, s.generate);
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

describe('the voting backend requires a schema-enforcing generative candidate (#2842)', () => {
	const FIXTURE = join(__dirname, 'fixtures', 'json-generative-module.cjs');
	const { ModelCapabilityError } = require('#src/resources/models/Models');
	const { applyModelsConfig } = require('#src/resources/models/bootstrap');

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

	it('passes requires: [structuredOutput] on every sample by default and omits it when the entry opts out', async () => {
		const s = scriptedGenerate([{ value: 'bug' }]);
		await createGenerativeDecisionBackend({ samples: 2 }, s.generate).decide('x', QUEUE, { accounting });
		assert.deepStrictEqual(
			s.calls.map(({ opts }) => opts.requires),
			[['structuredOutput'], ['structuredOutput']]
		);
		const s2 = scriptedGenerate([{ value: 'bug' }]);
		await createGenerativeDecisionBackend({ samples: 1, requireStructuredOutput: false }, s2.generate).decide(
			'x',
			QUEUE,
			{ accounting }
		);
		assert.strictEqual(s2.calls[0].opts.requires, undefined);
	});

	it('refuses a prompt-only generative backend before any completion, naming the capability', async () => {
		await bootstrapModels({
			models: {
				generative: { default: { backend: FIXTURE, answers: ['{"value":"bug"}'], structuredOutput: false } },
				decision: { default: { backend: 'generative', samples: 3 } },
			},
		});
		await assert.rejects(
			models.decide('x', QUEUE),
			(err) => err instanceof ModelCapabilityError && /structuredOutput/.test(err.message)
		);
	});

	it('samples a prompt-only backend when the entry opts out', async () => {
		await bootstrapModels({
			models: {
				generative: { default: { backend: FIXTURE, answers: ['{"value":"bug"}'], structuredOutput: false } },
				decision: { default: { backend: 'generative', samples: 2, requireStructuredOutput: false } },
			},
		});
		assert.strictEqual((await models.decide('x', QUEUE)).value, 'bug');
	});

	it('falls through a fallback group to the candidate that enforces the schema', async () => {
		await bootstrapModels({
			models: {
				generative: {
					default: { backend: FIXTURE, answers: ['{"value":"other"}'], structuredOutput: false, fallback: ['strict'] },
					strict: { backend: FIXTURE, answers: ['{"value":"bug"}'] },
				},
				decision: { default: { backend: 'generative', samples: 1 } },
			},
		});
		assert.strictEqual((await models.decide('x', QUEUE)).value, 'bug');
	});

	it('honors a hot reload that swaps the generative entry to a prompt-only backend on the next decision', async () => {
		await bootstrapModels({
			models: {
				generative: { default: { backend: 'ollama', model: 'llama3.2' } },
				decision: { default: { backend: 'generative', samples: 1 } },
			},
		});
		assert.strictEqual(resolveGenerative('default').capabilities().structuredOutput, true);
		await applyModelsConfig({
			generative: { default: { backend: 'anthropic', apiKey: 'k', model: 'claude' } },
			decision: { default: { backend: 'generative', samples: 1 } },
		});
		assert.strictEqual(resolveGenerative('default').capabilities().structuredOutput, false);
		await assert.rejects(models.decide('x', QUEUE), ModelCapabilityError);
	});
});
