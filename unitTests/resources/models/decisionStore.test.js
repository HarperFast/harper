'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../../testUtils');
const { resetDatabases, getDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const {
	DecisionStore,
	DecisionNotFoundError,
	DecisionPersistenceError,
	OutcomeReportError,
	DECISION_RETENTION_MS,
	getDecisionTables,
	resetDecisionTables,
	declareDecisionTablesAtBoot,
	newDecisionId,
	setModelsConfigHash,
	getModelsConfigHash,
} = require('#src/resources/models/decisionStore');
const { canonicalJson, hashSchema, scoringSchema } = require('#src/resources/models/decision');

const QUEUE = { enum: ['billing', 'refund', 'bug', 'other'] };
const TICKET = { type: 'object', properties: { queue: QUEUE, urgent: { type: 'boolean' } } };
const dist = (pairs) => pairs.map(([value, probability]) => ({ value, probability }));

function row(overrides = {}) {
	const at = Date.now();
	return {
		id: newDecisionId(),
		callId: 1000,
		at,
		expiresAt: at + DECISION_RETENTION_MS,
		backend: 'test',
		model: 'default',
		schema: QUEUE,
		schemaHash: hashSchema(QUEUE),
		value: 'bug',
		probability: 0.7,
		distribution: dist([
			['bug', 0.7],
			['billing', 0.3],
			['refund', 0],
			['other', 0],
		]),
		calibrated: false,
		...overrides,
	};
}

describe('DecisionStore against the system database', () => {
	let store;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		resetDecisionTables();
		store = new DecisionStore();
	});

	after(() => resetDecisionTables());

	it('declares both tables with an indexed expiresAt TTL and plain records', () => {
		const { decisions, outcomes } = getDecisionTables();
		for (const tbl of [decisions, outcomes]) {
			assert.strictEqual(tbl.loadAsInstance, false);
			const ttl = tbl.attributes.find((attribute) => attribute.name === 'expiresAt');
			assert.ok(ttl, 'expiresAt attribute declared');
			assert.strictEqual(ttl.expiresAt, true);
			assert.ok(ttl.indexed, 'expiresAt is indexed, so eviction can find it');
		}
	});

	it('round-trips a decision, reads an empty outcome, and answers undefined for an unknown id', async () => {
		const stored = row();
		await store.persist(stored);
		const record = await store.get(stored.id);
		assert.strictEqual(record.id, stored.id);
		assert.strictEqual(record.callId, 1000);
		assert.deepStrictEqual(record.schema, QUEUE);
		assert.deepStrictEqual(record.distribution, stored.distribution);
		assert.strictEqual(record.expiresAt, stored.expiresAt);
		assert.deepStrictEqual(record.outcome, {});
		assert.strictEqual(await store.get(newDecisionId()), undefined);
	});

	it('survives the tables being re-declared from disk', async () => {
		const stored = row();
		await store.persist(stored);
		resetDecisionTables();
		resetDatabases();
		const record = await new DecisionStore().get(stored.id);
		assert.strictEqual(record.value, 'bug');
	});

	it('records truth and action as separate facts with the decision expiry, and leaves an identical report untouched', async () => {
		const stored = row();
		await store.persist(stored);
		const first = await store.recordOutcome(stored.id, { truth: { kind: 'value', value: 'billing' } });
		assert.deepStrictEqual(first.outcome.truth, { kind: 'value', value: 'billing' });
		assert.strictEqual(typeof first.outcome.truthAt, 'number');
		assert.strictEqual(first.outcome.action, undefined);
		const { outcomes } = getDecisionTables();
		const fact = await outcomes.get(`${stored.id}/truth`);
		assert.strictEqual(fact.expiresAt, stored.expiresAt);
		assert.strictEqual(fact.decisionId, stored.id);
		await new Promise((resolve) => setTimeout(resolve, 5));
		const repeat = await store.recordOutcome(stored.id, { truth: { kind: 'value', value: 'billing' } });
		assert.strictEqual(repeat.outcome.truthAt, first.outcome.truthAt, 'an identical report writes nothing');
		const second = await store.recordOutcome(stored.id, { action: { kind: 'abstained' } });
		assert.deepStrictEqual(second.outcome.truth, { kind: 'value', value: 'billing' });
		assert.deepStrictEqual(second.outcome.action, { kind: 'abstained' });
	});

	it('overwrites one fact on a correction and never touches the other', async () => {
		const stored = row();
		await store.persist(stored);
		await store.recordOutcome(stored.id, {
			truth: { kind: 'value', value: 'bug' },
			action: { kind: 'value', value: 'bug' },
		});
		const corrected = await store.recordOutcome(stored.id, { truth: { kind: 'noMatch' } });
		assert.deepStrictEqual(corrected.outcome.truth, { kind: 'noMatch' });
		assert.deepStrictEqual(corrected.outcome.action, { kind: 'value', value: 'bug' });
		const reset = await store.recordOutcome(stored.id, { truth: { kind: 'unknown' } });
		assert.deepStrictEqual(reset.outcome.truth, { kind: 'unknown' });
	});

	it('keeps both facts when truth and action are reported concurrently', async () => {
		const stored = row();
		await store.persist(stored);
		await Promise.all([
			store.recordOutcome(stored.id, { truth: { kind: 'value', value: 'refund' } }),
			store.recordOutcome(stored.id, { action: { kind: 'noMatch' } }),
		]);
		const record = await store.get(stored.id);
		assert.deepStrictEqual(record.outcome.truth, { kind: 'value', value: 'refund' });
		assert.deepStrictEqual(record.outcome.action, { kind: 'noMatch' });
	});

	it('records per-field facts for an object schema', async () => {
		const stored = row({
			schema: TICKET,
			schemaHash: hashSchema(TICKET),
			value: { queue: 'bug', urgent: true },
			probability: undefined,
			distribution: undefined,
			fields: {
				queue: {
					value: 'bug',
					probability: 1,
					distribution: dist([
						['bug', 1],
						['billing', 0],
						['refund', 0],
						['other', 0],
					]),
				},
				urgent: {
					value: true,
					probability: 1,
					distribution: dist([
						[true, 1],
						[false, 0],
					]),
				},
			},
		});
		await store.persist(stored);
		const record = await store.recordOutcome(stored.id, {
			fields: { queue: { truth: { kind: 'value', value: 'other' } }, urgent: { action: { kind: 'abstained' } } },
		});
		assert.deepStrictEqual(record.outcome.fields.queue.truth, { kind: 'value', value: 'other' });
		assert.strictEqual(record.outcome.fields.queue.action, undefined);
		assert.deepStrictEqual(record.outcome.fields.urgent.action, { kind: 'abstained' });
		assert.strictEqual(record.outcome.fields.urgent.truth, undefined);
	});

	it('rejects reports that do not fit the stored schema, without echoing values', async () => {
		const leaf = row();
		const object = row({ schema: TICKET, schemaHash: hashSchema(TICKET), value: { queue: 'bug', urgent: true } });
		await store.persist(leaf);
		await store.persist(object);
		const rejects = (id, report, pattern) =>
			assert.rejects(
				store.recordOutcome(id, report),
				(err) => err instanceof OutcomeReportError && err.statusCode === 400 && pattern.test(err.message)
			);
		await rejects(leaf.id, { truth: { kind: 'value', value: 'spam' } }, /not an allowed value/);
		await assert.rejects(
			store.recordOutcome(leaf.id, { truth: { kind: 'value', value: 'spam' } }),
			(err) => !/spam/.test(err.message)
		);
		await rejects(leaf.id, { truth: { kind: 'maybe' } }, /unknown kind/);
		await rejects(leaf.id, { truth: 'bug' }, /tagged state/);
		await rejects(leaf.id, {}, /no fact/);
		await rejects(leaf.id, { fields: { queue: {} } }, /leaf schema/);
		await rejects(leaf.id, null, /must be an object/);
		await rejects(object.id, { truth: { kind: 'noMatch' } }, /object schema/);
		await rejects(object.id, { fields: { priority: { truth: { kind: 'noMatch' } } } }, /unknown field 'priority'/);
		await rejects(
			object.id,
			{ fields: { queue: { action: { kind: 'value', value: 'spam' } } } },
			/field 'queue': action/
		);
		await rejects(object.id, { fields: {} }, /no fact/);
	});

	it("answers 404 for an unknown id and hides another tenant's decision from both reads and reports", async () => {
		const stored = row({ tenant: 'acme' });
		await store.persist(stored);
		await assert.rejects(
			store.recordOutcome(newDecisionId(), { truth: { kind: 'noMatch' } }),
			(err) => err instanceof DecisionNotFoundError && err.statusCode === 404
		);
		assert.strictEqual(await store.get(stored.id, 'globex'), undefined);
		await assert.rejects(
			store.recordOutcome(stored.id, { truth: { kind: 'noMatch' } }, 'globex'),
			(err) => err instanceof DecisionNotFoundError && err.statusCode === 404
		);
		assert.strictEqual((await store.get(stored.id, 'acme')).tenant, 'acme');
		assert.strictEqual((await store.get(stored.id)).tenant, 'acme');
		const untenanted = row();
		await store.persist(untenanted);
		assert.strictEqual((await store.get(untenanted.id, 'globex')).id, untenanted.id);
	});

	it('declares both tables at boot on a writable node', () => {
		resetDecisionTables();
		declareDecisionTablesAtBoot();
		const declared = getDatabases().system?.hdb_model_outcomes;
		assert.ok(declared, 'hdb_model_outcomes is in the catalog');
		assert.ok(declared.attributes.some((attribute) => attribute.name === 'expiresAt' && attribute.expiresAt));
	});

	it('on a read-only node takes the tables the catalog holds without declaring, and reads nothing when they are absent', async () => {
		const stored = row();
		await store.persist(stored);
		resetDecisionTables();
		const readOnly = new DecisionStore({ getTables: () => getDecisionTables(true), isReadOnly: () => true });
		assert.strictEqual((await readOnly.get(stored.id)).id, stored.id);
		resetDecisionTables();
		const empty = new DecisionStore({
			getTables: () => ({ decisions: undefined, outcomes: undefined }),
			isReadOnly: () => true,
		});
		assert.strictEqual(await empty.get(stored.id), undefined);
	});

	it('refuses to record on a read-only node before touching storage', async () => {
		const readOnly = new DecisionStore({ isReadOnly: () => true, getTables: () => assert.fail('no table access') });
		assert.throws(
			() => readOnly.assertWritable('Decisions'),
			(err) => err instanceof DecisionPersistenceError && err.statusCode === 503 && /Decisions/.test(err.message)
		);
		await assert.rejects(
			readOnly.recordOutcome(newDecisionId(), { truth: { kind: 'noMatch' } }),
			(err) => err instanceof DecisionPersistenceError && err.statusCode === 503
		);
	});
});

describe('models config hash', () => {
	afterEach(() => setModelsConfigHash(undefined));

	it('ignores credential-looking keys, changes with the model, and is absent without a block', () => {
		setModelsConfigHash({ generative: { default: { backend: 'openai', model: 'a', apiKey: 'one' } } });
		const withOne = getModelsConfigHash();
		setModelsConfigHash({ generative: { default: { model: 'a', backend: 'openai', apiKey: 'two' } } });
		assert.strictEqual(getModelsConfigHash(), withOne);
		setModelsConfigHash({ generative: { default: { backend: 'openai', model: 'b', apiKey: 'one' } } });
		assert.notStrictEqual(getModelsConfigHash(), withOne);
		setModelsConfigHash({ generative: { default: { backend: 'openai', model: 'a', maxTokens: 1, tokenizer: 't' } } });
		const withOptions = getModelsConfigHash();
		setModelsConfigHash({ generative: { default: { backend: 'openai', model: 'a', maxTokens: 2, tokenizer: 't' } } });
		assert.notStrictEqual(getModelsConfigHash(), withOptions, 'maxTokens is configuration, not a credential');
		setModelsConfigHash({ generative: { default: { backend: 'acme', model: 'a', accessToken: 'one' } } });
		const withToken = getModelsConfigHash();
		setModelsConfigHash({ generative: { default: { backend: 'acme', model: 'a', accessToken: 'two' } } });
		assert.strictEqual(getModelsConfigHash(), withToken, 'a rotated token is not a configuration change');
		setModelsConfigHash({
			generative: { default: { backend: 'bedrock', accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' } },
		});
		assert.strictEqual(
			getModelsConfigHash(),
			(setModelsConfigHash({ generative: { default: { backend: 'bedrock' } } }), getModelsConfigHash())
		);
		setModelsConfigHash(undefined);
		assert.strictEqual(getModelsConfigHash(), undefined);
	});
});

describe('schema identity', () => {
	it('hashes independently of property order, includes descriptions, and stores the schema without them', () => {
		const a = {
			type: 'object',
			description: 'ticket',
			properties: { queue: { ...QUEUE, description: 'q' }, urgent: { type: 'boolean' } },
		};
		const b = {
			properties: { urgent: { type: 'boolean' }, queue: { description: 'q', ...QUEUE } },
			description: 'ticket',
			type: 'object',
		};
		assert.strictEqual(hashSchema(a), hashSchema(b));
		assert.notStrictEqual(hashSchema(a), hashSchema({ ...a, description: 'other' }));
		assert.strictEqual(canonicalJson({ b: [2, 1], a: 1 }), '{"a":1,"b":[2,1]}');
		assert.deepStrictEqual(scoringSchema(a), {
			type: 'object',
			properties: { queue: QUEUE, urgent: { type: 'boolean' } },
		});
		assert.deepStrictEqual(scoringSchema({ ...QUEUE, description: 'q' }), QUEUE);
		const extra = { ...QUEUE, meta: 1n, description: 'q' };
		assert.strictEqual(hashSchema(extra), hashSchema({ ...QUEUE, description: 'q' }));
		assert.deepStrictEqual(scoringSchema(extra), QUEUE);
		const mutable = { enum: ['a', 'b'] };
		const before = hashSchema(mutable);
		mutable.enum.push('c');
		assert.notStrictEqual(hashSchema(mutable), before, 'identity follows the current schema, not the object');
		assert.deepStrictEqual(scoringSchema(mutable), { enum: ['a', 'b', 'c'] });
	});
});
