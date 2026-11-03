require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
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
});
