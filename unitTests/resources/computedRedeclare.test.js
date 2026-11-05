require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath, stubMethod } = require('../testUtils');
const {
	table,
	CHECKPOINT_ALGORITHM,
	RESOLVED_CHECKPOINT_ALGORITHM,
	databaseEventsEmitter,
	__setReadOnlyModeForTest,
} = require('#src/resources/databases');
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

describe('re-declaring a table reports and rebuilds only a real computed change (harper#3970, #3971, #3972)', () => {
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

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

	async function populate(Table, count = 5) {
		let lastPut;
		for (let i = 0; i < count; i++) lastPut = Table.put({ id: 'k-' + i, name: 'n' + i });
		await lastPut;
	}

	async function idsWithScore(Table, value) {
		const ids = [];
		for await (const record of Table.search({ conditions: [{ attribute: 'score', value }] })) ids.push(record.id);
		return ids;
	}

	async function assertScores(Table, scoreOf, count = 5) {
		for (let i = 0; i < count; i++)
			assert.deepStrictEqual(await idsWithScore(Table, scoreOf('n' + i)), ['k-' + i], `row k-${i} is not indexed`);
	}

	it('re-declares one table through a no-op, a replaced function, a removal and a late resolver', async () => {
		// a new function with the same source on every call, as each application load produces
		const prefixFrom = (prefix) => new Function('record', `return '${prefix}-' + record.name;`);
		const key = 'ComputedSequence/score';
		const First = declare('ComputedSequence', { computed: { from: prefixFrom('a') } });
		await populate(First);
		await First.indexingOperation;
		await catalogFlushed(First);
		await assertScores(First, (name) => 'a-' + name);
		assert.strictEqual(First.dbisDB.getSync(key).checkpointAlgorithm, RESOLVED_CHECKPOINT_ALGORITHM);

		let announced = 0;
		const onUpdate = (updated) => {
			if (updated.tableName === 'ComputedSequence') announced++;
		};
		databaseEventsEmitter.on('updateTable', onUpdate);
		try {
			const build = First.indexingOperation;
			const schemaVersion = First.schemaVersion;
			const NoOp = declare('ComputedSequence', { computed: { from: prefixFrom('a') } });
			assert.strictEqual(NoOp.indexingOperation, build, 'a no-op re-declare rebuilt the index');
			assert.strictEqual(NoOp.schemaVersion, schemaVersion, 'a no-op re-declare reported a schema change');
			assert.strictEqual(announced, 0, 'a no-op re-declare announced the table');

			// the attribute as the catalog holds it, which is what a thread that loaded the table from the catalog re-declares
			const FromCatalog = declare('ComputedSequence', { ...First.dbisDB.getSync(key) });
			assert.strictEqual(FromCatalog.indexingOperation, build, 'a catalog-sourced re-declare rebuilt the index');
			assert.strictEqual(FromCatalog.schemaVersion, schemaVersion);
			assert.strictEqual(announced, 0);
		} finally {
			databaseEventsEmitter.off('updateTable', onUpdate);
		}

		const replacedBuild = First.indexingOperation;
		const Replaced = declare('ComputedSequence', { computed: { from: prefixFrom('b') } });
		assert.notStrictEqual(Replaced.indexingOperation, replacedBuild, 'a replaced function did not rebuild');
		await Replaced.indexingOperation;
		await assertScores(Replaced, (name) => 'b-' + name);
		assert.deepStrictEqual(await idsWithScore(Replaced, 'a-n1'), [], 'the old function left its keys');

		// a copy of the catalog attribute declared bare is a removal of the function, not its carried hash
		const removedBuild = Replaced.indexingOperation;
		const Bare = declare('ComputedSequence', { ...Replaced.dbisDB.getSync(key), computed: true });
		assert.notStrictEqual(Bare.indexingOperation, removedBuild, 'changing a function to bare did not rebuild');
		await Bare.indexingOperation;
		await catalogFlushed(Bare);
		assert.deepStrictEqual(await idsWithScore(Bare, 'b-n1'), [], 'the removed function still computed the index');
		assert.strictEqual(Bare.dbisDB.getSync(key).checkpointAlgorithm, CHECKPOINT_ALGORITHM);
		const bareBuild = Bare.indexingOperation;
		Bare.setComputedAttribute('score', (record) => 'c-' + record.name);
		assert.notStrictEqual(Bare.indexingOperation, bareBuild, 'a resolver for the bare attribute did not rebuild');
		await Bare.indexingOperation;
		await assertScores(Bare, (name) => 'c-' + name);

		const Stored = declare('ComputedSequence', {});
		await Stored.indexingOperation;
		const Unresolved = declare('ComputedSequence', { computed: true });
		await Unresolved.indexingOperation;
		await catalogFlushed(Unresolved);
		assert.deepStrictEqual(await idsWithScore(Unresolved, 'd-n1'), []);
		assert.strictEqual(Unresolved.dbisDB.getSync(key).checkpointAlgorithm, CHECKPOINT_ALGORITHM);

		const unresolvedBuild = Unresolved.indexingOperation;
		Unresolved.setComputedAttribute('score', (record) => 'd-' + record.name);
		assert.notStrictEqual(Unresolved.indexingOperation, unresolvedBuild, 'a late resolver did not rebuild');
		await Unresolved.indexingOperation;
		await catalogFlushed(Unresolved);
		await assertScores(Unresolved, (name) => 'd-' + name);
		assert.strictEqual(Unresolved.dbisDB.getSync(key).checkpointAlgorithm, RESOLVED_CHECKPOINT_ALGORITHM);

		const resolvedBuild = Unresolved.indexingOperation;
		Unresolved.setComputedAttribute('score', (record) => 'd-' + record.name);
		assert.strictEqual(Unresolved.indexingOperation, resolvedBuild, 'a certified index was rebuilt');
	});

	it('restarts a backfill whose resolver registers mid-scan', async () => {
		const Plain = declare('ComputedMidScan', {});
		await populate(Plain, 300);
		await Plain.indexingOperation;
		const resolver = (record) => 'm-' + record.name;
		const resolvers = Plain.userResolvers;
		let reads = 0;
		// registers the resolver from inside the scan, after some rows were computed without it
		Object.defineProperty(resolvers, 'score', {
			configurable: true,
			enumerable: true,
			get() {
				if (++reads < 40) return undefined;
				Plain.setComputedAttribute('score', resolver);
				return resolvers.score;
			},
			set(value) {
				if (value?.unresolved) return;
				Object.defineProperty(resolvers, 'score', { value, writable: true, configurable: true, enumerable: true });
			},
		});
		const MidScan = declare('ComputedMidScan', { computed: true });
		const build = MidScan.indexingOperation;
		await build;
		await catalogFlushed(MidScan);
		assert.ok(reads >= 40, 'the resolver was not registered during the scan');
		assert.strictEqual(MidScan.indexingOperation, build, 'the build should restart itself, not need a repair');
		await assertScores(MidScan, (name) => 'm-' + name, 300);
		assert.strictEqual(
			MidScan.dbisDB.getSync('ComputedMidScan/score').checkpointAlgorithm,
			RESOLVED_CHECKPOINT_ALGORITHM
		);
	});

	it('rebuilds an index without resolver certification once, when its resolver registers', async () => {
		const Computed = declare('ComputedLegacyStamp', { computed: true });
		Computed.setComputedAttribute('score', (record) => 'l-' + record.name);
		await populate(Computed);
		await Computed.indexingOperation;
		await catalogFlushed(Computed);
		const key = 'ComputedLegacyStamp/score';
		assert.strictEqual(Computed.dbisDB.getSync(key).checkpointAlgorithm, RESOLVED_CHECKPOINT_ALGORITHM);
		// what a release before resolver certification left on every completed index
		const written = Computed.dbisDB.put(key, {
			...Computed.dbisDB.getSync(key),
			checkpointAlgorithm: CHECKPOINT_ALGORITHM,
		});
		if (written?.then) await written;

		// a new process has no resolver until the application registers one
		delete Computed.userResolvers.score;
		const Restarted = declare('ComputedLegacyStamp', { computed: true });
		const declared = Restarted.indexingOperation;
		__setReadOnlyModeForTest(true);
		try {
			Restarted.setComputedAttribute('score', (record) => 'l-' + record.name);
		} finally {
			__setReadOnlyModeForTest(undefined);
		}
		assert.strictEqual(Restarted.indexingOperation, declared, 'a read-only server started a rebuild');

		Restarted.setComputedAttribute('score', (record) => 'l-' + record.name);
		const repair = Restarted.indexingOperation;
		assert.notStrictEqual(repair, declared, 'an uncertified index was not rebuilt');
		Restarted.setComputedAttribute('score', (record) => 'l-' + record.name);
		assert.strictEqual(Restarted.indexingOperation, repair, 'a second registration claimed a second build');
		await repair;
		await catalogFlushed(Restarted);
		await assertScores(Restarted, (name) => 'l-' + name);
		assert.strictEqual(Restarted.dbisDB.getSync(key).checkpointAlgorithm, RESOLVED_CHECKPOINT_ALGORITHM);
	});

	it("keeps an application resolver that is also another table's function `from`", async () => {
		const shared = (record) => 's-' + record.name;
		declare('ComputedSharedFrom', { computed: { from: shared } });
		const Bare = declare('ComputedSharedBare', { computed: true });
		Bare.setComputedAttribute('score', shared);
		const Again = declare('ComputedSharedBare', { computed: true });
		assert.strictEqual(Again.userResolvers.score, shared, "the other table's declaration removed this resolver");

		const fromOwn = (record) => 'o-' + record.name;
		declare('ComputedSharedFrom', { computed: { from: fromOwn } });
		const Dropped = declare('ComputedSharedFrom', { computed: true });
		Dropped.setComputedAttribute('score', fromOwn);
		const Reloaded = declare('ComputedSharedFrom', { computed: true });
		assert.strictEqual(
			Reloaded.userResolvers.score,
			fromOwn,
			'an explicit registration of a dropped function was removed'
		);

		// another thread declared a different function; this one reads that declaration from the catalog
		const fromNew = (record) => 'n-' + record.name;
		const Replaced = declare('ComputedSharedFrom', { computed: { from: fromNew } });
		const fromCatalog = { ...Replaced.dbisDB.getSync('ComputedSharedFrom/score'), computedFromHash: 'x'.repeat(22) };
		const Refreshed = declare('ComputedSharedFrom', fromCatalog);
		assert.strictEqual(
			Refreshed.userResolvers.score,
			undefined,
			'a function the catalog no longer declares kept resolving'
		);
	});

	// a finishing build can start a repair, which publishes a new operation
	async function settled(Table) {
		let operation;
		do {
			operation = Table.indexingOperation;
			await operation;
		} while (operation !== Table.indexingOperation);
		await catalogFlushed(Table);
	}

	async function uncertified(name, attributes) {
		const Built = table({
			table: name,
			database: 'test',
			schemaDefined: true,
			attributes: [{ name: 'id', type: 'ID', isPrimaryKey: true }, { name: 'name', type: 'String' }, ...attributes],
		});
		await populate(Built);
		await Built.indexingOperation;
		await catalogFlushed(Built);
		return Built;
	}

	it('leaves a repair to the thread whose claim the catalog already holds', async () => {
		const Computed = await uncertified('ComputedClaimedElsewhere', [
			{ name: 'score', type: 'String', indexed: true, computed: true },
		]);
		const key = 'ComputedClaimedElsewhere/score';
		// another thread's claim: durable, while this thread's own attribute and index still look idle
		const written = Computed.dbisDB.put(key, { ...Computed.dbisDB.getSync(key), indexingPID: process.pid + 1 });
		if (written?.then) await written;
		const build = Computed.indexingOperation;
		Computed.setComputedAttribute('score', (record) => 'c-' + record.name);
		assert.strictEqual(Computed.indexingOperation, build, 'a build the catalog shows claimed was claimed again');
		assert.ok(!Computed.indices.score.isIndexing);
	});

	it("repairs an index whose live attribute still carries a finished build's claim", async () => {
		const Computed = await uncertified('ComputedStaleClaim', [
			{ name: 'score', type: 'String', indexed: true, computed: true },
		]);
		// a re-declare during a build copies its claim onto the attribute that becomes live, and the build's
		// completion clears only its own attribute objects
		Computed.attributes.find((attribute) => attribute.name === 'score').indexingPID = process.pid;
		const build = Computed.indexingOperation;
		Computed.setComputedAttribute('score', (record) => 'j-' + record.name);
		assert.notStrictEqual(Computed.indexingOperation, build, 'a stale in-memory claim blocked the repair');
		await settled(Computed);
		await assertScores(Computed, (name) => 'j-' + name);
	});

	it("does not carry a finished build's resolver certification onto a rebuild claim", async () => {
		const Computed = declare('ComputedRebuildClaim', { computed: true, version: 1 });
		Computed.setComputedAttribute('score', (record) => 'v-' + record.name);
		await populate(Computed);
		await settled(Computed);
		const key = 'ComputedRebuildClaim/score';
		assert.strictEqual(Computed.dbisDB.getSync(key).checkpointAlgorithm, RESOLVED_CHECKPOINT_ALGORITHM);
		const Rebuilt = declare('ComputedRebuildClaim', { computed: true, version: 2 });
		await catalogFlushed(Rebuilt);
		assert.notStrictEqual(
			Rebuilt.dbisDB.getSync(key).checkpointAlgorithm,
			RESOLVED_CHECKPOINT_ALGORITHM,
			'a rebuild in progress is certified by the build it replaces'
		);
		await settled(Rebuilt);
	});

	it('keeps the runtime parts of a declaration through a repair claim', async () => {
		const Computed = await uncertified('ComputedRuntimeFields', [
			{ name: 'score', type: 'String', indexed: true, computed: true, elements: { type: 'String' } },
		]);
		const live = Computed.attributes.find((attribute) => attribute.name === 'score');
		const definition = { note: 'runtime only' };
		Object.defineProperty(live.elements, 'definition', { value: definition, enumerable: false });
		Computed.setComputedAttribute('score', (record) => 'r-' + record.name);
		await settled(Computed);
		assert.strictEqual(live.elements.definition, definition, 'the claim replaced a runtime declaration object');
	});

	it('certifies an empty table without touching the live attribute', async () => {
		const Empty = declare('ComputedEmptyLive', { computed: true });
		const live = Empty.attributes.find((attribute) => attribute.name === 'score');
		const runtime = { note: 'runtime only' };
		live.runtimeOnly = runtime;
		Empty.setComputedAttribute('score', (record) => 'e-' + record.name);
		await settled(Empty);
		assert.strictEqual(live.runtimeOnly, runtime, 'certifying an empty table rewrote the live attribute');
		assert.strictEqual(
			Empty.dbisDB.getSync('ComputedEmptyLive/score').checkpointAlgorithm,
			RESOLVED_CHECKPOINT_ALGORITHM
		);
	});

	it('holds no index for a repair claim that failed part way', async () => {
		const Computed = await uncertified('ComputedClaimFails', [
			{ name: 'first', type: 'String', indexed: true, computed: true },
			{ name: 'second', type: 'String', indexed: true, computed: true },
		]);
		const resolver = (record) => 'p-' + record.name;
		Computed.userResolvers.second = resolver;
		let puts = 0;
		const originalPutSync = Computed.dbisDB.putSync;
		const restore = stubMethod(Computed.dbisDB, 'putSync', function (...args) {
			if (++puts === 2) throw new Error('catalog write failed');
			return originalPutSync.apply(this, args);
		});
		const before = Computed.indexingOperation;
		try {
			Computed.setComputedAttribute('first', resolver);
		} finally {
			restore();
		}
		// LMDB rolls back the whole claim transaction; RocksDB keeps the first claim, so its build runs
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb')
			assert.strictEqual(Computed.indexingOperation, before, 'a claim its transaction rolled back started a build');
		else assert.notStrictEqual(Computed.indexingOperation, before, 'a durable claim was not built');
		await settled(Computed);
		for (const name of ['first', 'second']) {
			assert.ok(!Computed.indices[name].isIndexing, `${name} is held as indexing with no build`);
			assert.ok(!Computed.dbisDB.getSync('ComputedClaimFails/' + name).indexingPID, `${name} kept a claim`);
		}

		Computed.setComputedAttribute('first', resolver);
		await settled(Computed);
		for (const name of ['first', 'second'])
			assert.strictEqual(
				Computed.dbisDB.getSync('ComputedClaimFails/' + name).checkpointAlgorithm,
				RESOLVED_CHECKPOINT_ALGORITHM,
				`${name} was not rebuilt once the catalog accepted the claim`
			);
	});

	it('rebuilds a function index another thread built without the function', async () => {
		const from = (record) => 'f-' + record.name;
		const Computed = declare('ComputedRecoveredFunction', { computed: { from } });
		await populate(Computed);
		await Computed.indexingOperation;
		await catalogFlushed(Computed);
		const key = 'ComputedRecoveredFunction/score';
		const written = Computed.dbisDB.put(key, {
			...Computed.dbisDB.getSync(key),
			checkpointAlgorithm: CHECKPOINT_ALGORITHM,
		});
		if (written?.then) await written;

		const build = Computed.indexingOperation;
		const Redeclared = declare('ComputedRecoveredFunction', { computed: { from } });
		assert.notStrictEqual(Redeclared.indexingOperation, build, 'registering the function did not rebuild');
		await Redeclared.indexingOperation;
		await catalogFlushed(Redeclared);
		await assertScores(Redeclared, (name) => 'f-' + name);
		assert.strictEqual(Redeclared.dbisDB.getSync(key).checkpointAlgorithm, RESOLVED_CHECKPOINT_ALGORITHM);
	});
});
