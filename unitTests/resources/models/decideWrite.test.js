'use strict';

const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../../testUtils');
const { table } = require('#src/resources/databases');
const { loadGQLSchema } = require('#src/resources/graphql');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { __setDecideFnForTest } = require('#src/resources/models/decideHook');

const ROUTES = ['billing', 'refund', 'bug', 'other'];

// Deterministic stand-in for `models.decide`: routes by keyword, with a lower probability
// for "refund" so a confidence threshold separates the rows.
function fakeDecide() {
	const calls = [];
	const fn = async (state, schema, opts) => {
		calls.push({ state, schema, opts });
		const text = typeof state === 'string' ? state : JSON.stringify(state);
		if ('enum' in schema) {
			const value = text.includes('refund') ? 'refund' : text.includes('bug') ? 'bug' : 'other';
			return { id: 'row', value, probability: value === 'refund' ? 0.6 : 1, calibrated: false };
		}
		return { id: 'row', value: text.includes('urgent'), probability: 0.9, calibrated: false };
	};
	fn.calls = calls;
	return fn;
}

async function drain(iterable) {
	const out = [];
	for await (const record of iterable) out.push(record);
	return out;
}

// `@decide` through a real table: the pair is on the committed record, a confidence query
// works against the index, PATCH/null/replication semantics hold, and a failure stores nothing.
describe('@decide write path (real table)', () => {
	let T;
	let decideFn;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'DecideWrite',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'body', type: 'String' },
				{ name: 'tag', type: 'String' },
				{
					name: 'route',
					type: 'String',
					indexed: true,
					decide: { source: 'body', model: 'default', confidence: 'routeConfidence', schema: { enum: ROUTES } },
				},
				{ name: 'routeConfidence', type: 'Float', indexed: true },
				{
					name: 'urgent',
					type: 'Boolean',
					decide: { source: 'body', model: 'default', confidence: 'urgentConfidence', schema: { type: 'boolean' } },
				},
				{ name: 'urgentConfidence', type: 'Float' },
			],
		});
		T.updatedAttributes();
	});
	beforeEach(() => {
		decideFn = fakeDecide();
		__setDecideFnForTest(decideFn);
	});
	after(() => __setDecideFnForTest(undefined));

	it('put with the source stores value and confidence for every @decide attribute from the default decider', async () => {
		await transaction((context) => T.put({ id: 'r1', body: 'please refund, urgent' }, context));
		await transaction((context) => T.put({ id: 'b1', body: 'found a bug' }, context));
		const r1 = await T.get('r1');
		assert.equal(r1.route, 'refund');
		assert.equal(r1.routeConfidence, 0.6);
		assert.equal(r1.urgent, true);
		assert.equal(r1.urgentConfidence, 0.9);
		const b1 = await T.get('b1');
		assert.equal(b1.route, 'bug');
		assert.equal(b1.routeConfidence, 1);
		assert.equal(b1.urgent, false);
		assert.equal(decideFn.calls.length, 4, 'one call per attribute per write');
		assert.deepEqual(decideFn.calls[0].opts, { model: 'default', instructions: undefined });
	});

	it('a review queue is a range condition on the indexed confidence attribute', async () => {
		const queue = await drain(
			T.search({ conditions: [{ attribute: 'routeConfidence', comparator: 'less_than', value: 0.8 }] })
		);
		assert.deepEqual(
			queue.map((r) => r.id),
			['r1']
		);
		const refunds = await drain(T.search({ conditions: [{ attribute: 'route', value: 'refund' }] }));
		assert.deepEqual(
			refunds.map((r) => r.id),
			['r1']
		);
	});

	it('a patch without the source leaves the pair untouched and calls no model', async () => {
		await T.patch('r1', { tag: 'triaged' });
		const r1 = await T.get('r1');
		assert.equal(r1.tag, 'triaged');
		assert.equal(r1.route, 'refund');
		assert.equal(r1.routeConfidence, 0.6);
		assert.equal(decideFn.calls.length, 0);
	});

	it('a patch with the source decides again, and a null source clears value and confidence', async () => {
		await T.patch('r1', { body: 'now it is a bug' });
		let r1 = await T.get('r1');
		assert.equal(r1.route, 'bug');
		assert.equal(r1.routeConfidence, 1);
		assert.equal(decideFn.calls.length, 2);

		await T.patch('r1', { body: null });
		r1 = await T.get('r1');
		assert.equal(r1.route, null);
		assert.equal(r1.routeConfidence, null);
		assert.equal(r1.urgent, null);
		assert.equal(r1.urgentConfidence, null);
		assert.equal(decideFn.calls.length, 2, 'a null source does not call the model');
		const queue = await drain(
			T.search({ conditions: [{ attribute: 'routeConfidence', comparator: 'less_than', value: 0.8 }] })
		);
		assert.deepEqual(queue, [], 'a cleared confidence leaves the queue');
	});

	it('a write that carries the pair without the source stores it as given (caller-editable attributes)', async () => {
		await T.patch('b1', { route: 'other', routeConfidence: 0.25 });
		const b1 = await T.get('b1');
		assert.equal(b1.route, 'other');
		assert.equal(b1.routeConfidence, 0.25);
		assert.equal(decideFn.calls.length, 0);
	});

	it('a replication-style apply never decides: the record is stored as it arrived', async () => {
		const context = { source: {} };
		await transaction(context, async () => {
			const resource = await T.getResource('peer1', context);
			return resource._writeUpdate('peer1', { id: 'peer1', body: 'please refund' }, true, {
				isNotification: true,
				nodeId: 7,
			});
		});
		const peer1 = await T.get('peer1');
		assert.equal(peer1.body, 'please refund');
		assert.equal(peer1.route, undefined, 'a mixed-version originator wrote no pair; the receiver adds none');
		assert.equal(decideFn.calls.length, 0);
	});

	it('an override that returns a value outside the closed set fails the write and stores nothing', async () => {
		T.setDecideAttribute('route', async () => ({ value: 'shipping', probability: 1 }));
		try {
			await assert.rejects(
				transaction((context) => T.put({ id: 'bad', body: 'anything' }, context)),
				/outside its @decide set/
			);
			assert.equal(await T.get('bad'), undefined, 'the failed write must not commit');
		} finally {
			T.userSetDeciders.delete('route');
			T.updatedAttributes();
		}
	});

	it('a decider failure fails the write as a whole with a sanitized message', async () => {
		T.setDecideAttribute('route', async () => {
			throw new Error('https://internal-llm.svc:9000 key=sk-abc123 refused');
		});
		try {
			await assert.rejects(
				transaction((context) => T.put({ id: 'fail', body: 'anything' }, context)),
				(err) => {
					assert.match(err.message, /Failed to compute decision for attribute "route"/);
					assert.ok(!/sk-abc123|internal-llm/.test(err.message));
					return true;
				}
			);
			assert.equal(await T.get('fail'), undefined);
		} finally {
			T.userSetDeciders.delete('route');
			T.updatedAttributes();
		}
	});

	it('a caching table decides on the cache fill, and a fill-time failure never reaches the reader', async () => {
		const Cached = table({
			table: 'DecideCached',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'body', type: 'String' },
				{
					name: 'route',
					type: 'String',
					decide: { source: 'body', model: 'default', confidence: 'routeConfidence', schema: { enum: ROUTES } },
				},
				{ name: 'routeConfidence', type: 'Float' },
			],
		});
		Cached.updatedAttributes();
		Cached.sourcedFrom({
			get: async (id) => ({ id, body: id.startsWith('fail') ? 'boom' : `bug report ${id}` }),
			available: () => true,
		});
		let failures = 0;
		Cached.setDecideAttribute('route', async (record) => {
			if (record.body === 'boom') {
				failures++;
				throw new Error('backend down');
			}
			return { value: 'bug', probability: 1 };
		});
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			const filled = await Cached.get('c1');
			assert.equal(filled.body, 'bug report c1');
			let stored;
			for (let attempt = 0; attempt < 40 && !stored?.route; attempt++) {
				await delay(25);
				stored = Cached.primaryStore.get('c1');
			}
			assert.equal(stored?.route, 'bug', 'the cache write carries the decision');
			assert.equal(stored?.routeConfidence, 1);

			const failed = await Cached.get('fail1');
			assert.equal(failed.body, 'boom', 'the reader gets the source record even when the fill cannot decide');
			await delay(100);
			assert.equal(failures, 1);
			assert.equal(Cached.primaryStore.get('fail1'), undefined, 'the failed fill is not cached');
			assert.deepEqual(unhandled, []);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});
});

// A `decide` descriptor change is a metadata refresh: persisted, the registry rebuilt, no reindex.
describe('@decide schema reload', () => {
	before(() => setupTestDBPath());

	it('changing instructions persists the descriptor and refreshes the registry without reindexing', async () => {
		const schema = (instructions) => `type DecideReload @table {
			id: ID @primaryKey
			body: String
			route: String @indexed @decide(source: "body", values: ["a", "b"], instructions: "${instructions}")
		}`;
		await loadGQLSchema(schema('first'));
		const before = tables.DecideReload;
		const firstDecider = before.userDeciders.route;
		assert.equal(before.attributes.find((a) => a.name === 'route').decide.instructions, 'first');

		await loadGQLSchema(schema('second'));
		const after = tables.DecideReload;
		const route = after.attributes.find((a) => a.name === 'route');
		assert.equal(route.decide.instructions, 'second');
		assert.equal(after.decideAttributes[0].decide.instructions, 'second', 'decideAttributes refreshed');
		assert.notEqual(after.userDeciders.route, firstDecider, 'the default decider is rebuilt from the new descriptor');
		assert.equal(route.indexingPID, undefined, 'an instructions change must not schedule an index rebuild');
		assert.equal(after.indices?.route?.isIndexing ?? false, false);
	});
});
