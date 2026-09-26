'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../../testUtils');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { setDecision, clearRegistry, defineBackend } = require('#src/resources/models/backendRegistry');
const { clearRouting, setFallbackGroup } = require('#src/resources/models/routing');
const { TestBackend } = require('#src/resources/models/TestBackend');
const { Models } = require('#src/resources/models/Models');
const {
	DecisionStore,
	DecisionNotFoundError,
	DecisionPersistenceError,
	DECISION_RETENTION_MS,
	resetDecisionTables,
	setModelsConfigHash,
} = require('#src/resources/models/decisionStore');
const { hashSchema } = require('#src/resources/models/decision');

const QUEUE = { enum: ['billing', 'refund', 'bug', 'other'], description: 'Which queue handles this ticket?' };
const oneHot = (winner) => QUEUE.enum.map((value) => ({ value, probability: value === winner ? 1 : 0 }));

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

describe('models.decide persists its decision and models.recordOutcome scores it (#2840)', () => {
	let writer;
	let models;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		resetDecisionTables();
	});

	beforeEach(() => {
		clearRegistry();
		clearRouting();
		writer = makeMockWriter();
		models = new Models(writer, () => {});
		setDecision('default', new TestBackend());
	});

	afterEach(() => {
		clearRegistry();
		clearRouting();
		setModelsConfigHash(undefined);
	});

	after(() => resetDecisionTables());

	it('returns a cluster-unique id whose record links the analytics row and stores the scoring schema, its hash and the config hash', async () => {
		setModelsConfigHash({ decision: { default: { backend: 'generative' } } });
		const d = await models.decide('x', QUEUE);
		assert.match(d.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
		const record = await models.getDecision(d.id);
		assert.strictEqual(record.callId, 1000);
		assert.strictEqual(writer.records[0].method, 'decide');
		assert.strictEqual(record.backend, 'test');
		assert.strictEqual(record.model, 'default');
		assert.deepStrictEqual(record.schema, { enum: QUEUE.enum });
		assert.strictEqual(record.schemaHash, hashSchema(QUEUE));
		assert.strictEqual(typeof record.configHash, 'string');
		assert.strictEqual(record.value, d.value);
		assert.deepStrictEqual(record.distribution, d.distribution);
		assert.strictEqual(record.calibrated, false);
		assert.strictEqual(record.expiresAt - record.at, DECISION_RETENTION_MS);
		assert.deepStrictEqual(record.outcome, {});
	});

	it('records an outcome through the facade and 404s an unknown id', async () => {
		const d = await models.decide('x', QUEUE);
		const record = await models.recordOutcome(d.id, {
			truth: { kind: 'value', value: 'other' },
			action: { kind: 'value', value: d.value },
		});
		assert.deepStrictEqual(record.outcome.truth, { kind: 'value', value: 'other' });
		assert.deepStrictEqual(record.outcome.action, { kind: 'value', value: d.value });
		assert.deepStrictEqual((await models.getDecision(d.id)).outcome.truth, { kind: 'value', value: 'other' });
		await assert.rejects(
			models.recordOutcome('00000000-0000-4000-8000-000000000000', { truth: { kind: 'noMatch' } }),
			(err) => err instanceof DecisionNotFoundError && err.statusCode === 404
		);
		assert.strictEqual(await models.getDecision('00000000-0000-4000-8000-000000000000'), undefined);
		assert.strictEqual(writer.records.length, 1, 'recording an outcome writes no analytics row');
	});

	it('stores the schema as it was at the call, hashes per-call instructions, and reads storage faults as its own error', async () => {
		const mutable = { enum: ['billing', 'refund'] };
		const first = await models.decide('x', mutable);
		mutable.enum.push('bug');
		const second = await models.decide('x', mutable, { instructions: 'Prefer bug when unsure.' });
		assert.deepStrictEqual((await models.getDecision(first.id)).schema, { enum: ['billing', 'refund'] });
		const record = await models.getDecision(second.id);
		assert.deepStrictEqual(record.schema, { enum: ['billing', 'refund', 'bug'] });
		assert.match(record.instructionsHash, /^[0-9a-f]{64}$/);
		assert.strictEqual((await models.getDecision(first.id)).instructionsHash, undefined);
		const blank = await models.decide('x', mutable, { instructions: '' });
		assert.strictEqual((await models.getDecision(blank.id)).instructionsHash, undefined, 'empty instructions are none');
		const racing = { enum: ['a', 'b'] };
		setDecision(
			'racer',
			defineBackend({
				name: 'racer',
				decide: async (state, schema) => {
					racing.enum.push('c');
					assert.deepStrictEqual(schema, { enum: ['a', 'b'] }, 'the backend sees the snapshot');
					return {
						status: 'completed',
						output: {
							distribution: [
								{ value: 'a', probability: 1 },
								{ value: 'b', probability: 0 },
							],
						},
					};
				},
			})
		);
		const raced = await models.decide('x', racing, { model: 'racer' });
		assert.deepStrictEqual((await models.getDecision(raced.id)).schema, { enum: ['a', 'b'] });
		const faulty = new Models(
			writer,
			() => {},
			new DecisionStore({
				getTables: () => ({
					decisions: {
						get() {
							throw new Error('IO error at /data/path');
						},
					},
					outcomes: {},
				}),
			})
		);
		await assert.rejects(
			faulty.getDecision(first.id),
			(err) =>
				err instanceof DecisionPersistenceError &&
				err.message === 'Decision could not be read' &&
				/data\/path/.test(err.cause.message)
		);
	});

	it('mints a distinct id per decision', async () => {
		const ids = new Set();
		for (let i = 0; i < 25; i++) ids.add((await models.decide('x', QUEUE)).id);
		assert.strictEqual(ids.size, 25);
	});

	it('keeps the decision when the application transaction around it aborts', async () => {
		let id;
		await assert.rejects(
			transaction(async () => {
				id = (await models.decide('x', QUEUE)).id;
				throw new Error('application abort');
			}),
			/application abort/
		);
		assert.ok(await models.getDecision(id), 'the decision committed in its own transaction');
	});

	it('fails closed on a persistence error without trying the next candidate or a second analytics row', async () => {
		const failing = new DecisionStore({
			getTables: () => ({
				decisions: {
					put() {
						throw new Error('disk full');
					},
					get() {},
				},
				outcomes: { get() {}, put() {} },
			}),
		});
		const m = new Models(writer, () => {}, failing);
		let backupCalls = 0;
		setDecision('primary', new TestBackend());
		setDecision(
			'backup',
			defineBackend({
				name: 'backup',
				decide: async () => {
					backupCalls++;
					return { status: 'completed', output: { distribution: oneHot('other') } };
				},
			})
		);
		setFallbackGroup('decision', 'primary', ['backup']);
		await assert.rejects(
			m.decide('x', QUEUE, { model: 'primary' }),
			(err) =>
				err instanceof DecisionPersistenceError &&
				err.statusCode === 500 &&
				err.message === 'Decision could not be recorded' &&
				/disk full/.test(err.cause?.message) &&
				err.cause instanceof Error
		);
		assert.strictEqual(backupCalls, 0);
		assert.strictEqual(writer.records.length, 1);
		assert.strictEqual(writer.records[0].success, true);
	});

	it('rejects on a read-only node before routing, with no analytics row, and rejects outcome reports the same way', async () => {
		const m = new Models(writer, () => {}, new DecisionStore({ isReadOnly: () => true }));
		await assert.rejects(
			m.decide('x', QUEUE),
			(err) => err instanceof DecisionPersistenceError && err.statusCode === 503 && /read-only/.test(err.message)
		);
		assert.strictEqual(writer.records.length, 0);
		await assert.rejects(
			m.recordOutcome('00000000-0000-4000-8000-000000000000', { truth: { kind: 'noMatch' } }),
			(err) => err instanceof DecisionPersistenceError && err.statusCode === 503
		);
	});

	it('rejects a missing or non-string id with a 400', async () => {
		for (const bad of ['', 5, undefined, null]) {
			assert.throws(
				() => models.getDecision(bad),
				(err) => err.statusCode === 400
			);
			assert.throws(
				() => models.recordOutcome(bad, { truth: { kind: 'noMatch' } }),
				(err) => err.statusCode === 400
			);
		}
	});
});
