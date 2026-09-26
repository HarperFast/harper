'use strict';

const assert = require('node:assert');
const { join } = require('node:path');
const { setupTestDBPath } = require('../../testUtils');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { clearRegistry, defineBackend, setDecision } = require('#src/resources/models/backendRegistry');
const { clearRouting, registerRouter, setFallbackGroup } = require('#src/resources/models/routing');
const { Models, models } = require('#src/resources/models/Models');
const { ModelCapabilityError } = require('#src/resources/models/backendHelpers');
const {
	createGenerativeDecisionBackend,
	GenerativeDecisionError,
} = require('#src/resources/models/generativeDecision');
const { bootstrapModels, resetModelsProjection } = require('#src/resources/models/bootstrap');
const { resetDecisionTables } = require('#src/resources/models/decisionStore');
const {
	hashSchema,
	snapshotSchema,
	scoringSchema,
	toResponseSchema,
	validateDecisionSchema,
} = require('#src/resources/models/decision');
const { OpenAIBackend } = require('#src/components/openai/index');
const { ChoiceScoringUnsupportedError } = require('#src/resources/models/backendHelpers');

const QUEUE = { enum: ['billing', 'refund', 'bug', 'other'] };
const QUEUE_NM = { ...QUEUE, noMatch: true };
const accounting = {};
const close = (actual, expected, label) =>
	assert.ok(Math.abs(actual - expected) < 1e-9, `${label ?? ''} ${actual} ≠ ${expected}`);
const oneHot = (values, winner) => values.map((value) => ({ value, probability: value === winner ? 1 : 0 }));

function makeMockWriter() {
	const records = [];
	let nextId = 1;
	return {
		records,
		write(record) {
			records.push(record);
			return nextId++;
		},
	};
}

/** A decision backend returning `output` for every call; its capabilities are declared through `defineBackend`. */
function decider(name, output, spec = {}) {
	const calls = [];
	const backend = defineBackend({
		name,
		...spec,
		decide: async (state, schema, opts) => {
			calls.push({ state, schema, opts });
			return { status: 'completed', output: typeof output === 'function' ? output(schema) : output };
		},
	});
	backend.calls = calls;
	return backend;
}

function scriptedGenerate(answers) {
	const calls = [];
	let i = 0;
	const generate = async (input, opts) => {
		calls.push({ input, opts });
		const answer = answers[i++ % answers.length];
		if (answer instanceof Error) throw answer;
		return { content: typeof answer === 'string' ? answer : JSON.stringify(answer), finishReason: 'stop' };
	};
	return { generate, calls };
}

function scriptedScore(answers) {
	const calls = [];
	let i = 0;
	const score = async (input, choices, opts) => {
		calls.push({ input, choices, opts });
		const answer = answers[i++ % answers.length];
		if (answer instanceof Error) throw answer;
		return { logLikelihoods: answer };
	};
	return { score, calls };
}

describe('noMatch schema flag (#2846)', () => {
	it('accepts a boolean on a leaf, rejects anything else and a flag on an object schema root', () => {
		validateDecisionSchema(QUEUE_NM);
		validateDecisionSchema({ ...QUEUE, noMatch: false });
		validateDecisionSchema({ type: 'object', properties: { route: QUEUE_NM, urgent: { type: 'boolean' } } });
		assert.throws(
			() => validateDecisionSchema({ ...QUEUE, noMatch: 'true' }),
			(err) => err.statusCode === 400 && /noMatch must be a boolean/.test(err.message)
		);
		assert.throws(
			() => validateDecisionSchema({ type: 'object', noMatch: true, properties: { route: QUEUE } }),
			(err) => err.statusCode === 400 && /on a property, not on an object schema/.test(err.message)
		);
	});

	it('keeps noMatch: true in the snapshot, the stored schema and the hash; false reads as absent', () => {
		assert.deepStrictEqual(snapshotSchema(QUEUE_NM), { enum: QUEUE.enum, noMatch: true });
		assert.deepStrictEqual(scoringSchema(QUEUE_NM), { enum: QUEUE.enum, noMatch: true });
		assert.notStrictEqual(hashSchema(QUEUE_NM), hashSchema(QUEUE));
		assert.strictEqual(hashSchema({ ...QUEUE, noMatch: false }), hashSchema(QUEUE));
		assert.deepStrictEqual(snapshotSchema({ ...QUEUE, noMatch: false }), { enum: QUEUE.enum });
	});

	it('asks for { value, noMatch } only where a leaf opted in, so a field named noMatch cannot collide', () => {
		assert.deepStrictEqual(toResponseSchema(QUEUE), {
			type: 'object',
			properties: { value: { type: 'string', enum: QUEUE.enum } },
			required: ['value'],
			additionalProperties: false,
		});
		assert.deepStrictEqual(toResponseSchema(QUEUE_NM), {
			type: 'object',
			properties: {
				value: { type: 'string', enum: QUEUE.enum },
				noMatch: { type: 'boolean' },
			},
			required: ['value', 'noMatch'],
			additionalProperties: false,
		});
		const schema = toResponseSchema({
			type: 'object',
			properties: { noMatch: { type: 'boolean' }, route: QUEUE_NM },
		});
		assert.deepStrictEqual(schema.properties.noMatch, { type: 'boolean' });
		assert.deepStrictEqual(schema.properties.route.required, ['value', 'noMatch']);
		assert.deepStrictEqual(schema.properties.route.properties.value, { type: 'string', enum: QUEUE.enum });
	});
});

describe('models.decide with noMatch (#2846)', () => {
	let writer;
	let m;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		resetDecisionTables();
	});

	beforeEach(() => {
		clearRegistry();
		clearRouting();
		writer = makeMockWriter();
		m = new Models(writer, () => {});
	});

	afterEach(() => {
		clearRegistry();
		clearRouting();
	});

	after(() => resetDecisionTables());

	it('leaves a call without the flag exactly as before: no noMatch field and no noMatch requirement', async () => {
		const seen = [];
		const backend = decider('legacy', { distribution: oneHot(QUEUE.enum, 'bug'), noMatch: 0.9 });
		registerRouter({
			route: (req) => {
				seen.push([...req.requires]);
				return [backend];
			},
		});
		const d = await m.decide('x', QUEUE);
		assert.deepStrictEqual(Object.keys(d).sort(), ['calibrated', 'distribution', 'id', 'probability', 'value']);
		assert.deepStrictEqual(seen, [['decide']]);
		const record = await m.getDecision(d.id);
		assert.strictEqual(record.noMatch, undefined);
	});

	it('returns and stores the score for an opted-in leaf, beside the unchanged forced choice', async () => {
		setDecision(
			'default',
			decider('nm', { distribution: oneHot(QUEUE.enum, 'bug'), noMatch: 0.75 }, { noMatch: true })
		);
		const d = await m.decide('x', QUEUE_NM);
		assert.strictEqual(d.value, 'bug');
		assert.strictEqual(d.probability, 1);
		assert.strictEqual(d.noMatch, 0.75);
		const record = await m.getDecision(d.id);
		assert.strictEqual(record.noMatch, 0.75);
		assert.deepStrictEqual(record.schema, { enum: QUEUE.enum, noMatch: true });
	});

	it('scores only the opted-in fields of an object schema, including one named noMatch', async () => {
		const schema = {
			type: 'object',
			properties: { route: QUEUE_NM, noMatch: { type: 'boolean' } },
		};
		const output = {
			fields: {
				route: { distribution: oneHot(QUEUE.enum, 'refund'), noMatch: 0.2 },
				noMatch: { distribution: oneHot([false, true], true), noMatch: 0.99 },
			},
		};
		setDecision('default', decider('nm', output, { noMatch: true }));
		const d = await m.decide('x', schema);
		assert.deepStrictEqual(d.value, { route: 'refund', noMatch: true });
		assert.strictEqual(d.fields.route.noMatch, 0.2);
		assert.strictEqual('noMatch' in d.fields.noMatch, false);
		assert.strictEqual(d.noMatch, undefined);
		const record = await m.getDecision(d.id);
		assert.strictEqual(record.fields.route.noMatch, 0.2);
	});

	it('refuses a backend that does not claim noMatch, and skips one a custom router returns ahead of a capable one', async () => {
		const plain = decider('plain', { distribution: oneHot(QUEUE.enum, 'bug') });
		setDecision('default', plain);
		await assert.rejects(m.decide('x', QUEUE_NM), ModelCapabilityError);
		assert.strictEqual(plain.calls.length, 0);

		const capable = decider('capable', { distribution: oneHot(QUEUE.enum, 'other'), noMatch: 0 }, { noMatch: true });
		registerRouter({ route: () => [plain, capable] });
		writer.records.length = 0;
		const d = await m.decide('x', QUEUE_NM);
		assert.strictEqual(d.value, 'other');
		assert.strictEqual(plain.calls.length, 0);
		assert.deepStrictEqual(
			writer.records.map((r) => [r.backend, r.success, r.error_code]),
			[
				['plain', false, 'capability_unsupported'],
				['capable', true, undefined],
			]
		);
	});

	for (const [label, score] of [
		['a missing score', undefined],
		['a non-finite score', Number.NaN],
		['a score above one', 1.5],
		['a negative score', -0.1],
		['a string score', '0.5'],
	]) {
		it(`treats ${label} from a capable backend as a contract error and fails over`, async () => {
			const bad = decider('bad', { distribution: oneHot(QUEUE.enum, 'bug'), noMatch: score }, { noMatch: true });
			const good = decider('good', { distribution: oneHot(QUEUE.enum, 'refund'), noMatch: 0.1 }, { noMatch: true });
			setDecision('primary', bad);
			setDecision('secondary', good);
			setFallbackGroup('decision', 'primary', ['secondary']);
			const d = await m.decide('x', QUEUE_NM, { model: 'primary' });
			assert.strictEqual(d.value, 'refund');
			assert.strictEqual(d.noMatch, 0.1);
			const failure = writer.records.find((r) => r.backend === 'bad');
			assert.strictEqual(failure.success, false);
		});
	}

	it('reports an opted-in call as calibrated only when the no-match score is calibrated too', async () => {
		const output = { distribution: oneHot(QUEUE.enum, 'bug'), noMatch: 0.3, calibrated: true };
		setDecision('half', decider('half', output, { noMatch: true, calibrated: true }));
		setDecision('full', decider('full', output, { noMatch: true, calibrated: true, calibratedNoMatch: true }));
		assert.strictEqual((await m.decide('x', QUEUE, { model: 'half' })).calibrated, true, 'unflagged call unchanged');
		assert.strictEqual((await m.decide('x', QUEUE_NM, { model: 'half' })).calibrated, false);
		assert.strictEqual((await m.decide('x', QUEUE_NM, { model: 'full' })).calibrated, true);
		await assert.rejects(m.decide('x', QUEUE_NM, { model: 'half', requires: ['calibrated'] }), ModelCapabilityError);
		const d = await m.decide('x', QUEUE_NM, { model: 'full', requires: ['calibrated'] });
		assert.strictEqual(d.calibrated, true);
		assert.strictEqual((await m.decide('x', QUEUE, { model: 'half', requires: ['calibrated'] })).calibrated, true);
	});

	it('defineBackend claims calibratedNoMatch only together with noMatch and decide', () => {
		const caps = (spec) => defineBackend({ name: 'b', decide: async () => ({}), ...spec }).capabilities();
		assert.strictEqual(caps({}).noMatch, false);
		assert.strictEqual(caps({ noMatch: true }).noMatch, true);
		assert.strictEqual(caps({ calibratedNoMatch: true }).calibratedNoMatch, false);
		assert.strictEqual(caps({ noMatch: true, calibratedNoMatch: true }).calibratedNoMatch, true);
		const generateOnly = defineBackend({ name: 'g', generate: async () => ({}), noMatch: true }).capabilities();
		assert.strictEqual(generateOnly.noMatch, false);
	});
});

describe('generative adapter voting with noMatch (#2846)', () => {
	it('keeps the forced choice when every sample says no match, and reports the share that did', async () => {
		const all = scriptedGenerate([{ value: 'other', noMatch: true }]);
		const allOut = (
			await createGenerativeDecisionBackend({ samples: 4, scoring: 'vote' }, { generate: all.generate }).decide(
				'x',
				QUEUE_NM,
				{ accounting }
			)
		).output;
		assert.strictEqual(allOut.noMatch, 1);
		assert.deepStrictEqual(allOut.distribution, oneHot(QUEUE.enum, 'other'));

		const mixed = scriptedGenerate([
			{ value: 'bug', noMatch: false },
			{ value: 'bug', noMatch: true },
			{ value: 'refund', noMatch: false },
			{ value: 'bug', noMatch: false },
		]);
		const out = (
			await createGenerativeDecisionBackend({ samples: 4, scoring: 'vote' }, { generate: mixed.generate }).decide(
				'x',
				QUEUE_NM,
				{ accounting }
			)
		).output;
		assert.strictEqual(out.noMatch, 0.25);
		close(out.distribution.find((e) => e.value === 'bug').probability, 0.75);
		assert.deepStrictEqual(mixed.calls[0].opts.responseFormat.schema, toResponseSchema(QUEUE_NM));
		assert.match(mixed.calls[0].input.system, /"noMatch"/);
	});

	it('serves boolean and integer leaves, and object fields with and without the flag', async () => {
		const bool = scriptedGenerate([{ value: true, noMatch: false }]);
		const boolOut = (
			await createGenerativeDecisionBackend({ samples: 2, scoring: 'vote' }, { generate: bool.generate }).decide(
				'x',
				{ type: 'boolean', noMatch: true },
				{ accounting }
			)
		).output;
		assert.strictEqual(boolOut.noMatch, 0);
		const int = scriptedGenerate([{ value: 3, noMatch: true }]);
		const intOut = (
			await createGenerativeDecisionBackend({ samples: 2, scoring: 'vote' }, { generate: int.generate }).decide(
				'x',
				{ type: 'integer', minimum: 1, maximum: 5, noMatch: true },
				{ accounting }
			)
		).output;
		assert.strictEqual(intOut.noMatch, 1);
		const schema = { type: 'object', properties: { route: QUEUE_NM, noMatch: { type: 'boolean' } } };
		const obj = scriptedGenerate([{ route: { value: 'bug', noMatch: true }, noMatch: false }]);
		const objOut = (
			await createGenerativeDecisionBackend({ samples: 2, scoring: 'vote' }, { generate: obj.generate }).decide(
				'x',
				schema,
				{ accounting }
			)
		).output;
		assert.strictEqual(objOut.fields.route.noMatch, 1);
		assert.strictEqual('noMatch' in objOut.fields.noMatch, false);
		assert.strictEqual(objOut.fields.noMatch.distribution.find((e) => e.value === false).probability, 1);
		assert.match(obj.calls[0].input.system, /Answer "route" each as/);
	});

	it('rejects a sample that leaves out the boolean, and leaves the unflagged prompt and schema untouched', async () => {
		const missing = scriptedGenerate([{ value: 'bug' }]);
		await assert.rejects(
			createGenerativeDecisionBackend({ samples: 2, scoring: 'vote' }, { generate: missing.generate }).decide(
				'x',
				QUEUE_NM,
				{ accounting }
			),
			(err) => err instanceof GenerativeDecisionError && /noMatch/.test(err.message)
		);
		const plain = scriptedGenerate([{ value: 'bug' }]);
		await createGenerativeDecisionBackend({ samples: 1, scoring: 'vote' }, { generate: plain.generate }).decide(
			'x',
			QUEUE,
			{ accounting }
		);
		assert.doesNotMatch(plain.calls[0].input.system, /noMatch/);
		assert.deepStrictEqual(plain.calls[0].opts.responseFormat.schema, toResponseSchema(QUEUE));
	});

	it('stops promptly when the caller aborts an opted-in vote', async () => {
		const controller = new AbortController();
		const generate = (_input, opts) =>
			new Promise((_resolve, reject) => {
				opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
			});
		const pending = createGenerativeDecisionBackend({ samples: 3, scoring: 'vote' }, { generate }).decide(
			'x',
			QUEUE_NM,
			{ accounting, signal: controller.signal }
		);
		controller.abort(new Error('caller went away'));
		await assert.rejects(pending, /caller went away/);
	});
});

describe('generative adapter scoring with noMatch (#2846)', () => {
	it('scores one extra choice, reports its share, and renormalizes the allowed values without it', async () => {
		const s = scriptedScore([[Math.log(0.4), Math.log(0.1), Math.log(0.1), Math.log(0.2), Math.log(0.2)]]);
		const out = (
			await createGenerativeDecisionBackend({ scoring: 'score' }, { score: s.score, canScore: () => true }).decide(
				'x',
				QUEUE_NM,
				{ accounting }
			)
		).output;
		assert.deepStrictEqual(s.calls[0].choices, [...QUEUE.enum, '(none of the listed values)']);
		assert.match(s.calls[0].input.system, /final option when none of the allowed values fits/);
		close(out.noMatch, 0.2);
		close(out.distribution[0].probability, 0.5, 'billing');
		close(
			out.distribution.reduce((sum, e) => sum + e.probability, 0),
			1
		);
		assert.match(out.signature, /mode=score/);
	});

	it('keeps the extra choice distinct from an allowed value with the same text, and leaves unflagged leaves unchanged', async () => {
		const leaf = { enum: ['yes', '(none of the listed values)'], noMatch: true };
		const s = scriptedScore([
			[0, 0, 0],
			[0, 0, 0, 0],
		]);
		const backend = createGenerativeDecisionBackend({ scoring: 'score' }, { score: s.score, canScore: () => true });
		await backend.decide('x', leaf, { accounting });
		assert.deepStrictEqual(s.calls[0].choices, ['yes', '(none of the listed values)', '((none of the listed values))']);
		await backend.decide('x', QUEUE, { accounting });
		assert.deepStrictEqual(s.calls[1].choices, QUEUE.enum);
		assert.doesNotMatch(s.calls[1].input.system, /final option/);
	});

	it('an opted-in leaf of 20 values exceeds OpenAI scoring by one choice, declined before any request', async () => {
		let requests = 0;
		const backend = new OpenAIBackend({ apiKey: 'k', model: 'm' }, async () => {
			requests++;
			throw new Error('no request expected');
		});
		const choices = Array.from({ length: 21 }, (_, i) => `v${i}`);
		await assert.rejects(backend.scoreChoices('x', choices, { accounting }), ChoiceScoringUnsupportedError);
		assert.strictEqual(requests, 0);
	});
});

describe('noMatch end to end through bootstrap (#2846)', () => {
	const JSON_FIXTURE = join(__dirname, 'fixtures', 'json-generative-module.cjs');
	const SCORING_FIXTURE = join(__dirname, 'fixtures', 'scoring-generative-module.cjs');

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		resetDecisionTables();
	});

	beforeEach(() => {
		clearRegistry();
		clearRouting();
		resetModelsProjection();
		require(SCORING_FIXTURE).calls.length = 0;
	});

	afterEach(() => {
		clearRegistry();
		clearRouting();
		resetModelsProjection();
	});

	after(() => resetDecisionTables());

	it('votes through config, returns the score, and reads it back from the durable record', async () => {
		await bootstrapModels({
			models: {
				generative: {
					default: {
						backend: JSON_FIXTURE,
						answers: ['{"value":"other","noMatch":true}', '{"value":"bug","noMatch":false}'],
					},
				},
				decision: { default: { backend: 'generative', samples: 4, scoring: 'vote' } },
			},
		});
		const d = await models.decide('an unrelated question', QUEUE_NM);
		assert.strictEqual(d.noMatch, 0.5);
		const record = await models.getDecision(d.id);
		assert.strictEqual(record.noMatch, 0.5);
		assert.strictEqual(record.value, d.value);
	});

	it('scores through config with the extra choice and reads the score back', async () => {
		await bootstrapModels({
			models: {
				generative: { default: { backend: SCORING_FIXTURE, scores: [[0, 0, 0, 0, Math.log(4)]] } },
				decision: { default: { backend: 'generative' } },
			},
		});
		const d = await models.decide('x', QUEUE_NM);
		close(d.noMatch, 0.5);
		const calls = require(SCORING_FIXTURE).calls;
		assert.deepStrictEqual(
			calls.map((c) => c.method),
			['scoreChoices']
		);
		assert.strictEqual(calls[0].choices.length, 5);
		const record = await models.getDecision(d.id);
		close(record.noMatch, 0.5);
	});
});
