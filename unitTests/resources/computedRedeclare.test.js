require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, CHECKPOINT_ALGORITHM } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

describe('re-declaring a table that adds or removes a bare @computed (harper#3782)', () => {
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	// LMDB commits catalog writes asynchronously, so wait for the pending batch before reading descriptors
	async function catalogFlushed(Table) {
		if (Table.dbisDB.committed) await Table.dbisDB.committed;
	}

	function declare(name, scoreAttribute) {
		return table({
			table: name,
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
				{ name: 'score', type: 'String', indexed: true, ...scoreAttribute },
			],
		});
	}

	it('persists each change and rebuilds the index', async () => {
		const Plain = declare('ComputedRedeclare', {});
		let lastPut;
		for (let i = 0; i < 5; i++) lastPut = Plain.put({ id: 'k-' + i, name: 'n' + i, score: 's' + i });
		await lastPut;
		if (Plain.indexingOperation) await Plain.indexingOperation;
		await catalogFlushed(Plain);
		const key = 'ComputedRedeclare/score';
		assert.ok(!Plain.dbisDB.getSync(key).computed);

		const plainBuild = Plain.indexingOperation;
		const Computed = declare('ComputedRedeclare', { computed: true });
		assert.notStrictEqual(Computed.indexingOperation, plainBuild, 'adding @computed must rebuild');
		await Computed.indexingOperation;
		await catalogFlushed(Computed);
		assert.ok(Computed.dbisDB.getSync(key).computed, 'adding @computed was not persisted');
		assert.ok(Computed.attributes.find((attribute) => attribute.name === 'score').computed);

		const computedBuild = Computed.indexingOperation;
		const Removed = declare('ComputedRedeclare', {});
		assert.notStrictEqual(Removed.indexingOperation, computedBuild, 'removing @computed must rebuild');
		await Removed.indexingOperation;
		await catalogFlushed(Removed);
		assert.ok(!Removed.dbisDB.getSync(key).computed, 'removing @computed was not persisted');
		assert.ok(!Removed.attributes.find((attribute) => attribute.name === 'score').computed);
	});

	it('persists a change to computedFromExpression', async () => {
		const Before = declare('ComputedExpressionRedeclare', { computed: {}, computedFromExpression: 'name' });
		await Before.indexingOperation;
		await catalogFlushed(Before);
		const key = 'ComputedExpressionRedeclare/score';
		assert.strictEqual(Before.dbisDB.getSync(key).computedFromExpression, 'name');

		const After = declare('ComputedExpressionRedeclare', { computed: {}, computedFromExpression: 'id' });
		await After.indexingOperation;
		await catalogFlushed(After);
		assert.strictEqual(After.dbisDB.getSync(key).computedFromExpression, 'id');
	});

	it('drops the user resolver and stops requiring application code once @computed is removed', async () => {
		const Computed = declare('ComputedResolverRemoved', { computed: true });
		Computed.setComputedAttribute('score', (record) => record.name);
		assert.ok(Computed.requiresApplicationCodeToReplicate());

		const Removed = declare('ComputedResolverRemoved', {});
		await Removed.indexingOperation;
		assert.strictEqual(Removed.userResolvers.score, undefined, 'the resolver of a removed @computed survived');
		assert.ok(!Removed.requiresApplicationCodeToReplicate());

		const Readded = declare('ComputedResolverRemoved', { computed: true });
		await Readded.indexingOperation;
		assert.deepStrictEqual(
			Readded.unresolvedComputedIndexes(),
			['score'],
			'a stale resolver masked the re-added attribute'
		);
	});

	it('drops a schema-generated resolver when the expression goes away, and keeps an application resolver', async () => {
		const Expression = declare('ComputedExpressionRemoved', { computed: {}, computedFromExpression: 'name' });
		assert.strictEqual(typeof Expression.userResolvers.score, 'function');
		assert.ok(!Expression.requiresApplicationCodeToReplicate());

		const Bare = declare('ComputedExpressionRemoved', { computed: true });
		await Bare.indexingOperation;
		assert.strictEqual(Bare.userResolvers.score, undefined, 'the removed expression kept resolving');
		assert.deepStrictEqual(Bare.unresolvedComputedIndexes(), ['score']);

		Bare.setComputedAttribute('score', (record) => record.name);
		const Again = declare('ComputedExpressionRemoved', { computed: true });
		assert.strictEqual(typeof Again.userResolvers.score, 'function', 'an unchanged bare declaration lost its resolver');
		assert.deepStrictEqual(Again.unresolvedComputedIndexes(), []);
	});

	it('does not resume a certified checkpoint built under the previous computation', async () => {
		const Before = declare('ComputedCheckpoint', { computed: {}, computedFromExpression: 'name' });
		let lastPut;
		for (let i = 0; i < 5; i++) lastPut = Before.put({ id: 'k-' + i, name: 'n' + i });
		await lastPut;
		await Before.indexingOperation;
		await catalogFlushed(Before);
		const key = 'ComputedCheckpoint/score';
		const interrupted = {
			...Before.dbisDB.getSync(key),
			indexingPID: 999999,
			lastIndexedKey: 'k-2',
			checkpointCertified: 'k-2',
			checkpointAlgorithm: CHECKPOINT_ALGORITHM,
		};
		const written = Before.dbisDB.put(key, interrupted);
		if (written?.then) await written;

		const After = declare('ComputedCheckpoint', { computed: {}, computedFromExpression: 'id' });
		await After.indexingOperation;
		for (let i = 0; i < 5; i++) {
			const matches = [];
			for await (const record of After.search({ conditions: [{ attribute: 'score', value: 'k-' + i }] }))
				matches.push(record.id);
			assert.deepStrictEqual(matches, ['k-' + i], `row k-${i} was not reindexed under the new expression`);
		}
	});

	it('does not resume a certified checkpoint when only the computation version changes', async () => {
		const Before = declare('ComputedVersionCheckpoint', { computed: true, version: 1 });
		Before.setComputedAttribute('score', (record) => record.name);
		let lastPut;
		for (let i = 0; i < 5; i++) lastPut = Before.put({ id: 'k-' + i, name: 'n' + i });
		await lastPut;
		await Before.indexingOperation;
		await catalogFlushed(Before);
		const key = 'ComputedVersionCheckpoint/score';
		const written = Before.dbisDB.put(key, {
			...Before.dbisDB.getSync(key),
			indexingPID: 999999,
			lastIndexedKey: 'k-2',
			checkpointCertified: 'k-2',
			checkpointAlgorithm: CHECKPOINT_ALGORITHM,
		});
		if (written?.then) await written;

		const After = declare('ComputedVersionCheckpoint', { computed: true, version: 2 });
		After.setComputedAttribute('score', (record) => record.id);
		await After.indexingOperation;
		for (let i = 0; i < 5; i++) {
			const matches = [];
			for await (const record of After.search({ conditions: [{ attribute: 'score', value: 'k-' + i }] }))
				matches.push(record.id);
			assert.deepStrictEqual(matches, ['k-' + i], `row k-${i} was not reindexed under the new version`);
		}
	});

	it('does not rebuild when a bare @computed changes only between true and {}', async () => {
		const Bare = declare('ComputedBareShape', { computed: true });
		let lastPut;
		for (let i = 0; i < 3; i++) lastPut = Bare.put({ id: 'k-' + i, name: 'n' + i });
		await lastPut;
		await Bare.indexingOperation;
		const build = Bare.indexingOperation;
		const Empty = declare('ComputedBareShape', { computed: {} });
		assert.strictEqual(Empty.indexingOperation, build, 'an equivalent bare declaration must not rebuild');
	});
});
