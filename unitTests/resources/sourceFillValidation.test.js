require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor.js');

describe('Source fill schema validation', function () {
	this.timeout(10_000);
	let Validated, Stamped, LongStamped, BigIntKeyed, Embedded, Loose, Sealed, responses, calls;

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
		LongStamped = table({
			database: 'test',
			table: 'SourceFillValidatedLongStamps',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String', nullable: false },
				{ name: 'createdAt', type: 'Long', assignCreatedTime: true },
				{ name: 'updatedAt', type: 'Long', assignUpdatedTime: true },
			],
		});
		BigIntKeyed = table({
			database: 'test',
			table: 'SourceFillValidatedBigIntKey',
			attributes: [
				{ name: 'id', type: 'BigInt', isPrimaryKey: true },
				{ name: 'name', type: 'String', nullable: false },
			],
		});
		Embedded = table({
			database: 'test',
			table: 'SourceFillValidatedEmbed',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'text', type: 'String' },
				{
					name: 'embedding',
					type: 'array',
					elements: { type: 'Float' },
					nullable: false,
					embed: { source: 'text', model: 'default' },
				},
			],
		});
		Embedded.setEmbedAttribute('embedding', async () => [0.5, 0.25]);
		Loose = table({
			database: 'test',
			table: 'SourceFillValidatedLoose',
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
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
		for (const Table of [Validated, Stamped, LongStamped, BigIntKeyed, Embedded, Loose, Sealed]) sourceFor(Table);
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
		await rejectedFill(Sealed, 'extra', '1 undeclared property');
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

	it('fills a source record on a table whose @createdTime and @updatedTime are Long', async () => {
		responses.set('long-stamped', { name: 'n' });
		const record = await LongStamped.get('long-stamped');
		assert.equal(typeof record.updatedAt, 'number');
		assert.equal((await settled(LongStamped, 'long-stamped')).value.createdAt, record.createdAt);
	});

	it('converts and checks a @createdTime the source supplies, as a put of it would', async () => {
		const createdAt = '2026-01-02T03:04:05.000Z';
		responses.set('created-string', { name: 'n', createdAt });
		const record = await Stamped.get('created-string');
		assert.ok(record.createdAt instanceof Date);
		assert.equal(record.createdAt.toISOString(), createdAt);
		assert.ok((await settled(Stamped, 'created-string')).value.createdAt instanceof Date);
		responses.set('created-garbage', { name: 'n', createdAt: { bad: 1 } });
		await rejectedFill(Stamped, 'created-garbage', 'createdAt');
	});

	it('fills a fractional Long @createdTime that an upstream Harper table stamped', async () => {
		const createdAt = 1795291750105.197;
		responses.set('upstream-stamped', { name: 'n', createdAt });
		assert.equal((await LongStamped.get('upstream-stamped')).createdAt, createdAt);
		assert.equal((await settled(LongStamped, 'upstream-stamped')).value.createdAt, createdAt);
	});

	it('rejects a Long @createdTime the source supplies that is not a safe integer-range number', async () => {
		for (const [id, createdAt] of [
			['created-infinite', Infinity],
			['created-huge', 1e20],
		]) {
			responses.set(id, { name: 'n', createdAt });
			await rejectedFill(LongStamped, id, 'createdAt');
		}
	});

	it('fills a required @embed attribute the source leaves for Harper to derive', async () => {
		responses.set('embedded', { text: 't' });
		await Embedded.get('embedded');
		assert.deepEqual([...(await settled(Embedded, 'embedded')).value.embedding], [0.5, 0.25]);
	});

	it('checks an @embed attribute the fill will not compute, without its source field', async () => {
		responses.set('unembedded', {});
		await rejectedFill(Embedded, 'unembedded', 'embedding');
		responses.set('bad-vector', { embedding: 'not-a-vector' });
		await rejectedFill(Embedded, 'bad-vector', 'embedding');
		responses.set('supplied-vector', { text: 't', embedding: 'not-a-vector' });
		await rejectedFill(Embedded, 'supplied-vector', 'embedding');
		responses.set('uncached-vector', { text: 't' });
		await rejectedFill(Embedded, 'uncached-vector', 'embedding', { noCacheStore: true });
	});

	it('rejects a source that returns an array or binary data instead of a record', async () => {
		for (const [id, response] of [
			['array', [{ name: 'n' }]],
			['array-buffer', new ArrayBuffer(8)],
			['buffer', Buffer.from('binary')],
		]) {
			responses.set(id, response);
			await assert.rejects(Loose.get(id), (error) => {
				assert.equal(error.statusCode, 502);
				assert.match(error.message, /^Source for SourceFillValidatedLoose returned a record that is not an object/);
				return true;
			});
			assert.equal((await settled(Loose, id))?.value ?? undefined, undefined);
		}
	});

	it('leaves the requested id on a BigInt key as it is, whatever key the source returns', async () => {
		responses.set(12, { id: 'not-a-number', name: 'n' });
		const record = await BigIntKeyed.get(12);
		assert.strictEqual(record.id, 12);
		assert.strictEqual((await settled(BigIntKeyed, 12)).value.id, 12);
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
