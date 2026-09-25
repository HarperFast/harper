'use strict';

const assert = require('node:assert');
require('#src/resources/databases');
const { contextStorage } = require('#src/resources/transaction');
const {
	setDecision,
	clearRegistry,
	registerBackend,
	defineBackend,
	resolveDecision,
	listBackends,
	ModelBackendNotFoundError,
	ModelBackendRegistrationError,
} = require('#src/resources/models/backendRegistry');
const { clearRouting, setFallbackGroup } = require('#src/resources/models/routing');
const { TestBackend } = require('#src/resources/models/TestBackend');
const { Models, ModelCapabilityError } = require('#src/resources/models/Models');
const { DecisionContractError, DecisionSchemaError, DecisionInputError } = require('#src/resources/models/decision');

const QUEUE = { enum: ['billing', 'refund', 'bug', 'other'], description: 'Which queue handles this ticket?' };
const dist = (pairs) => pairs.map(([value, probability]) => ({ value, probability }));
const oneHot = (winner) => dist(QUEUE.enum.map((v) => [v, v === winner ? 1 : 0]));

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

/** A decision backend whose outputs are scripted per call; an Error entry is thrown. */
function scripted(name, outputs, extra = {}) {
	let i = 0;
	return defineBackend({
		name,
		calibrated: extra.calibrated,
		decide: async () => {
			const next = outputs[Math.min(i++, outputs.length - 1)];
			if (next instanceof Error) throw next;
			return { status: 'completed', output: next };
		},
	});
}

describe('models.decide', () => {
	let writer;
	let metricSpy;
	let models;

	beforeEach(() => {
		clearRegistry();
		clearRouting();
		writer = makeMockWriter();
		metricSpy = makeMetricSpy();
		models = new Models(writer, metricSpy.emitter);
		setDecision('default', new TestBackend());
	});

	afterEach(() => {
		clearRegistry();
		clearRouting();
	});

	it('returns a complete, descending distribution with the argmax as value (TestBackend)', async () => {
		const state = 'My card was charged twice';
		const d = await models.decide(state, QUEUE);
		assert.strictEqual(typeof d.id, 'string');
		assert.ok(QUEUE.enum.includes(d.value));
		assert.strictEqual(d.distribution.length, 4);
		assert.strictEqual(d.distribution[0].value, d.value);
		assert.strictEqual(d.distribution[0].probability, d.probability);
		for (let i = 1; i < d.distribution.length; i++) {
			assert.ok(d.distribution[i - 1].probability >= d.distribution[i].probability);
		}
		const sum = d.distribution.reduce((s, e) => s + e.probability, 0);
		assert.ok(Math.abs(sum - 1) < 1e-6);
		assert.strictEqual(d.calibrated, false);
		assert.deepStrictEqual(d.usage, { promptTokens: state.length, latencyMs: 0 });
	});

	it('is deterministic for the same state and schema, and accepts object state', async () => {
		const a = await models.decide({ body: 'refund please' }, QUEUE);
		const b = await models.decide({ body: 'refund please' }, QUEUE);
		assert.deepStrictEqual(a.distribution, b.distribution);
	});

	it('returns per-field marginals for an object schema', async () => {
		const schema = { type: 'object', properties: { queue: QUEUE, urgent: { type: 'boolean' } } };
		const d = await models.decide('help', schema);
		assert.deepStrictEqual(Object.keys(d.fields), ['queue', 'urgent']);
		assert.deepStrictEqual(d.value, { queue: d.fields.queue.value, urgent: d.fields.urgent.value });
		assert.strictEqual(d.probability, undefined);
		assert.strictEqual(d.distribution, undefined);
		assert.strictEqual(d.fields.urgent.distribution.length, 2);
	});

	it('records an hdb_model_calls row with method=decide whose id the Decision references, and emits metrics', async () => {
		const d = await models.decide('x', QUEUE, { model: 'default' });
		assert.strictEqual(writer.records.length, 1);
		const r = writer.records[0];
		assert.strictEqual(r.method, 'decide');
		assert.strictEqual(r.backend, 'test');
		assert.strictEqual(r.model, 'default');
		assert.strictEqual(r.success, true);
		assert.strictEqual(r.prompt_tokens, 1);
		assert.strictEqual(d.id, '1000');
		assert.ok(metricSpy.calls.some((c) => c.metric === 'model-decide' && c.value === 1 && c.path === 'test'));
		assert.ok(metricSpy.calls.some((c) => c.metric === 'model-decide-tokens' && c.value === 1));
	});

	it('rejects a malformed schema or state before routing, with no analytics row', async () => {
		await assert.rejects(
			models.decide('x', { enum: ['only'] }),
			(err) => err instanceof DecisionSchemaError && err.statusCode === 400
		);
		await assert.rejects(
			models.decide(null, QUEUE),
			(err) => err instanceof DecisionInputError && err.statusCode === 400
		);
		const cyclic = {};
		cyclic.self = cyclic;
		await assert.rejects(models.decide(cyclic, QUEUE), DecisionInputError);
		assert.strictEqual(writer.records.length, 0);
	});

	it("records an unknown logical name as backend='unknown' / backend_not_found", async () => {
		await assert.rejects(models.decide('x', QUEUE, { model: 'nope' }), ModelBackendNotFoundError);
		const r = writer.records[0];
		assert.deepStrictEqual(
			[r.backend, r.error_code, r.method, r.model],
			['unknown', 'backend_not_found', 'decide', 'nope']
		);
	});

	it("throws ModelCapabilityError when requires: ['calibrated'] is unmet, and routes to a calibrated backend when it is met", async () => {
		await assert.rejects(models.decide('x', QUEUE, { requires: ['calibrated'] }), ModelCapabilityError);
		assert.strictEqual(writer.records[0].error_code, 'capability_unsupported');
		setDecision('cal', scripted('cal', [{ distribution: oneHot('bug') }], { calibrated: true }));
		const d = await models.decide('x', QUEUE, { model: 'cal', requires: ['calibrated'] });
		assert.strictEqual(d.value, 'bug');
		assert.strictEqual(d.calibrated, true);
	});

	it('treats a contract violation as a backend error: records it and falls through to the next candidate', async () => {
		setDecision('primary', scripted('primary', [{ value: 'bug' }]));
		setDecision('backup', scripted('backup', [{ distribution: oneHot('refund') }]));
		setFallbackGroup('decision', 'primary', ['backup']);
		const d = await models.decide('x', QUEUE, { model: 'primary' });
		assert.strictEqual(d.value, 'refund');
		assert.strictEqual(writer.records.length, 2);
		assert.deepStrictEqual(
			writer.records.map((r) => [r.backend, r.success, r.error_code]),
			[
				['primary', false, 'backend_error'],
				['backup', true, undefined],
			]
		);
	});

	it('surfaces the primary error when every candidate fails', async () => {
		setDecision('primary', scripted('primary', [{ value: 'bug' }]));
		setDecision('backup', scripted('backup', [new Error('backup down')]));
		setFallbackGroup('decision', 'primary', ['backup']);
		await assert.rejects(models.decide('x', QUEUE, { model: 'primary' }), DecisionContractError);
	});

	it('does not call a backend when the signal is already aborted', async () => {
		let calls = 0;
		setDecision(
			'counting',
			defineBackend({
				name: 'counting',
				decide: async () => {
					calls++;
					return { status: 'completed', output: { distribution: oneHot('bug') } };
				},
			})
		);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			models.decide('x', QUEUE, { model: 'counting', signal: controller.signal }),
			(err) => err.name === 'AbortError'
		);
		assert.strictEqual(calls, 0);
	});

	it('reads accounting from the ALS context like the other methods', async () => {
		await contextStorage.run({ user: { tenant: 'acme' }, handlerPath: '/tickets' }, () => models.decide('x', QUEUE));
		assert.strictEqual(writer.records[0].tenant, 'acme');
		assert.strictEqual(writer.records[0].app, '/tickets');
	});

	it('hands the backend instructions and accounting, but never the logical name as opts.model', async () => {
		let seen;
		setDecision(
			'spy',
			defineBackend({
				name: 'spy',
				decide: async (_state, _schema, opts) => {
					seen = opts;
					return { status: 'completed', output: { distribution: oneHot('bug') } };
				},
			})
		);
		await models.decide('x', QUEUE, { model: 'spy', instructions: 'be terse' });
		assert.strictEqual(seen.model, undefined);
		assert.strictEqual(seen.instructions, 'be terse');
		assert.ok(seen.accounting);
	});
});

describe('decision backends in the registry', () => {
	beforeEach(() => clearRegistry());
	afterEach(() => clearRegistry());

	it("registerBackend('decision', ...) requires decide(), and defineBackend derives decide/calibrated", () => {
		const embedOnly = defineBackend({ name: 'x', embed: async () => ({ status: 'completed', output: [] }) });
		assert.throws(
			() => registerBackend('decision', 'x', embedOnly),
			(err) => err instanceof ModelBackendRegistrationError && /must implement decide/.test(err.message)
		);
		const b = defineBackend({ name: 'd', decide: async () => ({ status: 'completed', output: {} }), calibrated: true });
		assert.deepStrictEqual(b.capabilities(), {
			embed: false,
			generate: false,
			stream: false,
			tools: false,
			adapters: false,
			decide: true,
			calibrated: true,
		});
		registerBackend('decision', 'd', b);
		assert.strictEqual(resolveDecision('d'), b);
		assert.deepStrictEqual(listBackends('decision'), [{ logicalName: 'd', backend: b }]);
		assert.throws(() => resolveDecision('missing'), ModelBackendNotFoundError);
	});

	it('calibrated stays false without decide, and an unknown kind still throws', () => {
		const b = defineBackend({ name: 'e', embed: async () => ({ status: 'completed', output: [] }), calibrated: true });
		assert.strictEqual(b.capabilities().calibrated, false);
		assert.throws(() => registerBackend('classifier', 'x', b), /kind must be 'embedding', 'generative' or 'decision'/);
	});

	it('models.registerBackend + models.defineBackend + models.decide work end to end for a decision backend', async () => {
		const models = new Models(makeMockWriter(), () => {});
		models.registerBackend(
			'decision',
			'local:cls',
			models.defineBackend({
				name: 'local:cls',
				decide: async () => ({ status: 'completed', output: { distribution: oneHot('other') } }),
			})
		);
		const d = await models.decide('x', QUEUE, { model: 'local:cls' });
		assert.strictEqual(d.value, 'other');
		assert.strictEqual(d.probability, 1);
	});
});
