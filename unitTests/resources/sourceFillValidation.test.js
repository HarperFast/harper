require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor.js');

// A cache fill is held to the schema a put of the same record must meet (harper#2733).
describe('Source fill schema validation', function () {
	this.timeout(10_000);
	let Validated, Stamped, Sealed, responses, calls;

	function sourceFor(Table) {
		Table.sourcedFrom({
			get(id) {
				calls.push(id);
				const response = responses.get(id);
				return typeof response === 'function' ? response() : response;
			},
		});
	}

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		Validated = table({
			database: 'test',
			table: 'SourceFillValidated',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true, nullable: false },
				{ name: 'name', type: 'String', nullable: false, indexed: true },
				{ name: 'count', type: 'Int' },
				{ name: 'seen', type: 'Date' },
				{ name: 'big', type: 'BigInt' },
				{ name: 'secret', type: 'Int' },
			],
		});
		Stamped = table({
			database: 'test',
			table: 'SourceFillValidatedStamps',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String', nullable: false },
				{ name: 'createdAt', type: 'Date', nullable: false, assignCreatedTime: true },
				{ name: 'updatedAt', type: 'Date', nullable: false, assignUpdatedTime: true },
			],
		});
		Sealed = table({
			database: 'test',
			table: 'SourceFillValidatedSealed',
			sealed: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
			],
		});
		for (const Table of [Validated, Stamped, Sealed]) sourceFor(Table);
	});

	beforeEach(() => {
		calls = [];
		responses = new Map();
	});

	function isSourceSchemaFailure(Table, paths) {
		return (error) => {
			assert.equal(error.statusCode, 502);
			const expected =
				`Source for ${Table.tableName} returned a record that does not match the schema` +
				(paths ? ` (invalid: ${paths})` : '');
			assert.ok(error.message.startsWith(expected + ' while resolving record'), error.message);
			return true;
		};
	}

	async function settled(Table, id) {
		await waitFor(() => !Table.primaryStore.hasLock(id), { message: `the fill of ${id} never released its lock` });
		return Table.primaryStore.getEntry(id);
	}

	async function rejectedFill(Table, id, paths, options) {
		await assert.rejects(Table.get(id, options), isSourceSchemaFailure(Table, paths));
		assert.equal((await settled(Table, id))?.value ?? undefined, undefined, 'the invalid record was cached');
	}

	it('rejects a source record missing a required attribute, as a put of it is', async () => {
		const record = { id: 'missing-name', count: 1 };
		await assert.rejects(async () => Validated.put('missing-name', record), { statusCode: 400 });
		responses.set('missing-name', record);
		await rejectedFill(Validated, 'missing-name', 'name');
		// nothing was cached, so the next read asks the source again, and a corrected record fills
		await rejectedFill(Validated, 'missing-name', 'name');
		responses.set('missing-name', { ...record, name: 'fixed' });
		assert.equal((await Validated.get('missing-name')).name, 'fixed');
		assert.equal((await settled(Validated, 'missing-name')).value.name, 'fixed');
		assert.deepEqual(calls, ['missing-name', 'missing-name', 'missing-name']);
	});

	it('names the invalid attributes without quoting the values the source returned', async () => {
		responses.set('leaky', { id: 'leaky', name: 'n', count: 'three', secret: 'sentinel-secret-value' });
		await assert.rejects(Validated.get('leaky'), (error) => {
			isSourceSchemaFailure(Validated, 'count, secret')(error);
			assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), /sentinel-secret-value|three/);
			return true;
		});
	});

	it('rejects a value whose coercion throws, as a 502', async () => {
		responses.set('bad-bigint', { id: 'bad-bigint', name: 'n', big: 'not-a-number' });
		await rejectedFill(Validated, 'bad-bigint');
	});

	it('rejects a source record with an attribute a sealed table does not declare', async () => {
		responses.set('extra', { id: 'extra', name: 'n', extra: true });
		await rejectedFill(Sealed, 'extra', 'extra');
	});

	it('rejects an invalid record read with noCacheStore', async () => {
		responses.set('uncached', { id: 'uncached', count: 1 });
		await rejectedFill(Validated, 'uncached', 'name', { noCacheStore: true });
	});

	it('coerces a source record the way a put does, in the served and the stored record', async () => {
		const seen = '2026-01-02T03:04:05.000Z';
		responses.set('coerced', { id: 'coerced', name: 'n', count: 3, seen, big: '12' });
		const record = await Validated.get('coerced');
		assert.ok(record.seen instanceof Date);
		assert.equal(record.seen.toISOString(), seen);
		assert.equal(record.big, 12n);
		const stored = (await settled(Validated, 'coerced')).value;
		assert.ok(stored.seen instanceof Date);
		assert.equal(stored.big, 12n);
	});

	it('fills a source record that leaves out its primary key, which the requested id supplies', async () => {
		responses.set('keyless', { name: 'n' });
		assert.equal((await Validated.get('keyless')).id, 'keyless');
		assert.equal((await settled(Validated, 'keyless')).value.name, 'n');
	});

	it('fills a numeric id on an ID key, as a put of it stores', async () => {
		await Sealed.put(41, { name: 'n' });
		responses.set(42, { name: 'n' });
		assert.equal((await Sealed.get(42)).id, 42);
		assert.equal((await settled(Sealed, 42)).value.name, 'n');
	});

	it('fills a source record that leaves out required @createdTime and @updatedTime attributes', async () => {
		responses.set('stamped', { name: 'n' });
		const record = await Stamped.get('stamped');
		assert.ok(record.createdAt instanceof Date);
		assert.ok(record.updatedAt instanceof Date);
		assert.equal((await settled(Stamped, 'stamped')).value.name, 'n');
	});

	it('every reader waiting on an invalid fill settles, and none caches it', async () => {
		let release;
		const gate = new Promise((resolve) => (release = resolve));
		responses.set('waited', async () => {
			await gate;
			return { id: 'waited', count: 1 };
		});
		const reads = [Validated.get('waited'), Validated.get('waited'), Validated.get('waited')];
		release();
		const outcomes = await Promise.allSettled(reads);
		for (const outcome of outcomes) {
			assert.equal(outcome.status, 'rejected');
			isSourceSchemaFailure(Validated, 'name')(outcome.reason);
		}
		assert.equal((await settled(Validated, 'waited'))?.value ?? undefined, undefined);
	});

	it('an invalid refill leaves the cached record and its index entries unchanged', async () => {
		await Validated.put('kept', { id: 'kept', name: 'cached' });
		await Validated.invalidate('kept');
		const before = Validated.primaryStore.getEntry('kept');
		responses.set('kept', { id: 'kept', count: 'three' });
		await assert.rejects(Validated.get('kept'), isSourceSchemaFailure(Validated, 'name, count'));
		const after = await settled(Validated, 'kept');
		assert.equal(after.value.name, 'cached');
		assert.equal(after.version, before.version);
		const indexed = Array.from(Validated.indices.name.getRange({}))
			.filter(({ value }) => value === 'kept')
			.map(({ key }) => key);
		assert.deepEqual(indexed, ['cached']);
	});

	it('serves the cached copy for an invalid refill under stale-if-error', async () => {
		for (const [id, invalid] of [
			['stale', { count: 1 }],
			['stale-bigint', { name: 'n', big: 'not-a-number' }],
		]) {
			await Validated.put(id, { id, name: 'cached' }, { expiresAt: Date.now() + 20 });
			await waitFor(() => Validated.primaryStore.getEntry(id).expiresAt < Date.now());
			responses.set(id, { id, ...invalid });
			const record = await Validated.get(id, { staleIfError: true });
			assert.equal(record.name, 'cached');
			assert.equal((await settled(Validated, id)).value.name, 'cached');
		}
		assert.deepEqual(calls, ['stale', 'stale-bigint']);
	});

	it('keeps the cached record on a 304 revalidation', async () => {
		await Validated.put('revalidated', { id: 'revalidated', name: 'cached' }, { expiresAt: Date.now() + 20 });
		await waitFor(() => Validated.primaryStore.getEntry('revalidated').expiresAt < Date.now());
		responses.set('revalidated', { status: 304, headers: new Map() });
		assert.equal((await Validated.get('revalidated')).name, 'cached');
		assert.deepEqual(calls, ['revalidated']);
	});
});
