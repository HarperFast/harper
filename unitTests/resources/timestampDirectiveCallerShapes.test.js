// The v5.1.26 -> v5.2.0 step added only the code-first `types.date.updatedTime` / `.createdTime`
// builders (182971ad1, #1767); the Table.ts stamping these tests exercise is identical in both tags.

require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { loadGQLSchema } = require('#src/resources/graphql');
const { databases } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { defineTable, types } = require('#src/resources/defineTable');
const { defineResource, schemaOf } = require('#src/resources/defineResource');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { waitFor } = require('../waitFor.js');

const DB = 'timestamp_shapes';

async function rejection(promiseOrFn) {
	try {
		await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
	} catch (error) {
		return error;
	}
	assert.fail('expected a rejection');
}

describe('@updatedTime / @createdTime caller shapes', () => {
	let DateStamped, FloatStamped, LongStamped, StringStamped, LegacyStamped;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		await loadGQLSchema(`
			type TsDate @table(database: "${DB}") {
				id: ID @primaryKey
				name: String
				createdAt: Date @createdTime
				updatedAt: Date @updatedTime
			}
			type TsFloat @table(database: "${DB}") {
				id: ID @primaryKey
				name: String
				createdAt: Float @createdTime
				updatedAt: Float @updatedTime
			}
			type TsLong @table(database: "${DB}") {
				id: ID @primaryKey
				name: String
				updatedAt: Long @updatedTime
			}
			type TsString @table(database: "${DB}") {
				id: ID @primaryKey
				name: String
				createdAt: String @createdTime
				updatedAt: String @updatedTime
			}
		`);
		DateStamped = databases[DB].TsDate;
		FloatStamped = databases[DB].TsFloat;
		LongStamped = databases[DB].TsLong;
		StringStamped = databases[DB].TsString;
		// Operations-API create_table tables carry untyped __createdtime__/__updatedtime__ attributes.
		LegacyStamped = table({
			table: 'TsLegacy',
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: '__createdtime__' },
				{ name: '__updatedtime__' },
			],
		});
	});

	describe('stamped value type and precision', () => {
		it('Date column: put stamps a Date equal to the record version, truncated to whole ms', async () => {
			await DateStamped.put('d1', { id: 'd1', name: 'a' });
			const record = await DateStamped.get('d1');
			assert.ok(record.updatedAt instanceof Date);
			assert.ok(record.createdAt instanceof Date);
			assert.strictEqual(record.updatedAt.getTime(), Math.trunc(record.getUpdatedTime()));
			assert.strictEqual(record.createdAt.getTime(), record.updatedAt.getTime());
		});

		it('Float column: put stamps the raw record version as a number (sub-ms precision kept)', async () => {
			await FloatStamped.put('f1', { id: 'f1', name: 'a' });
			const record = await FloatStamped.get('f1');
			assert.strictEqual(typeof record.updatedAt, 'number');
			assert.strictEqual(record.updatedAt, record.getUpdatedTime());
			assert.strictEqual(record.createdAt, record.updatedAt);
		});

		it('Long column: put stamps the raw record version, unrounded (the Long type is not enforced on the stamp)', async () => {
			await LongStamped.put('n1', { id: 'n1', name: 'a' });
			const record = await LongStamped.get('n1');
			assert.strictEqual(record.updatedAt, record.getUpdatedTime());
		});

		it('String column: put stamps an ISO-8601 string of the record version', async () => {
			await StringStamped.put('s1', { id: 's1', name: 'a' });
			const record = await StringStamped.get('s1');
			assert.strictEqual(record.updatedAt, new Date(record.getUpdatedTime()).toISOString());
			assert.strictEqual(record.createdAt, record.updatedAt);
		});

		it('legacy untyped __updatedtime__/__createdtime__: stamped as the raw record version number', async () => {
			await LegacyStamped.put('l1', { id: 'l1', name: 'a' });
			const record = await LegacyStamped.get('l1');
			assert.strictEqual(record.__updatedtime__, record.getUpdatedTime());
			assert.strictEqual(record.__createdtime__, record.__updatedtime__);
		});
	});

	describe('when the stamp is (re)applied', () => {
		it('put of an existing record re-stamps updatedTime and keeps the original createdTime', async () => {
			await FloatStamped.put('f2', { id: 'f2', name: 'a' });
			const first = await FloatStamped.get('f2');
			await FloatStamped.put('f2', { id: 'f2', name: 'b' });
			const second = await FloatStamped.get('f2');
			assert.ok(second.updatedAt > first.updatedAt);
			assert.strictEqual(second.createdAt, first.createdAt);
		});

		it('patch re-stamps updatedTime and leaves createdTime untouched', async () => {
			await FloatStamped.put('f3', { id: 'f3', name: 'a' });
			const first = await FloatStamped.get('f3');
			await FloatStamped.patch('f3', { name: 'b' });
			const second = await FloatStamped.get('f3');
			assert.strictEqual(second.name, 'b');
			assert.ok(second.updatedAt > first.updatedAt);
			assert.strictEqual(second.updatedAt, second.getUpdatedTime());
			assert.strictEqual(second.createdAt, first.createdAt);
		});

		it('patch of a missing record creates it and stamps both times, overwriting caller values', async () => {
			await FloatStamped.patch('f4', { name: 'new', createdAt: 5, updatedAt: 6 });
			const record = await FloatStamped.get('f4');
			assert.strictEqual(record.updatedAt, record.getUpdatedTime());
			assert.strictEqual(record.createdAt, record.updatedAt);
		});

		it('create (POST to the collection) stamps both times, overwriting caller values', async () => {
			const created = await FloatStamped.create({ name: 'posted', createdAt: 5, updatedAt: 6 });
			const record = await FloatStamped.get(created.id);
			assert.strictEqual(record.updatedAt, record.getUpdatedTime());
			assert.strictEqual(record.createdAt, record.updatedAt);
		});

		it('patch with unchanged values still re-stamps updatedTime', async () => {
			await FloatStamped.put('f10', { id: 'f10', name: 'same' });
			const first = await FloatStamped.get('f10');
			await FloatStamped.patch('f10', { name: 'same' });
			const second = await FloatStamped.get('f10');
			assert.ok(second.updatedAt > first.updatedAt);
		});

		it('an empty patch writes nothing and leaves updatedTime unchanged', async () => {
			await FloatStamped.put('f11', { id: 'f11', name: 'a' });
			const first = await FloatStamped.get('f11');
			await FloatStamped.patch('f11', {});
			const second = await FloatStamped.get('f11');
			assert.strictEqual(second.updatedAt, first.updatedAt);
			assert.strictEqual(second.getUpdatedTime(), first.getUpdatedTime());
		});
	});

	describe('caller-supplied timestamp values', () => {
		it('a well-typed updatedTime on put or patch is overwritten with the record version', async () => {
			await FloatStamped.put('f5', { id: 'f5', name: 'a', updatedAt: 1 });
			let record = await FloatStamped.get('f5');
			assert.strictEqual(record.updatedAt, record.getUpdatedTime());
			await FloatStamped.patch('f5', { updatedAt: 2 });
			record = await FloatStamped.get('f5');
			assert.strictEqual(record.updatedAt, record.getUpdatedTime());
		});

		it('a well-typed createdTime on insert is overwritten with the record version', async () => {
			await FloatStamped.put('f6', { id: 'f6', name: 'a', createdAt: 1 });
			const record = await FloatStamped.get('f6');
			assert.strictEqual(record.createdAt, record.getUpdatedTime());
		});

		it('a createdTime on put (any value) or a truthy one on patch of an existing record is replaced by the stored createdTime', async () => {
			await FloatStamped.put('f7', { id: 'f7', name: 'a' });
			const original = (await FloatStamped.get('f7')).createdAt;
			await FloatStamped.put('f7', { id: 'f7', name: 'b', createdAt: 1 });
			assert.strictEqual((await FloatStamped.get('f7')).createdAt, original);
			await FloatStamped.put('f7', { id: 'f7', name: 'c', createdAt: null });
			assert.strictEqual((await FloatStamped.get('f7')).createdAt, original);
			await FloatStamped.patch('f7', { createdAt: 2 });
			assert.strictEqual((await FloatStamped.get('f7')).createdAt, original);
		});

		it('a falsy createdTime (0 or null) on patch of an existing record overwrites the stored createdTime', async () => {
			// Known defect: the patch retention guard tests the supplied value's truthiness, not its
			// presence. Flip these assertions when that guard is fixed.
			await FloatStamped.put('f12', { id: 'f12', name: 'a' });
			await FloatStamped.patch('f12', { createdAt: 0 });
			assert.strictEqual((await FloatStamped.get('f12')).createdAt, 0);
			await FloatStamped.patch('f12', { createdAt: null });
			assert.strictEqual((await FloatStamped.get('f12')).createdAt, null);
		});

		it('a null updatedTime on put or patch is replaced by the record version', async () => {
			await FloatStamped.put('f13', { id: 'f13', name: 'a', updatedAt: null });
			assert.strictEqual((await FloatStamped.get('f13')).updatedAt, (await FloatStamped.get('f13')).getUpdatedTime());
			await FloatStamped.patch('f13', { updatedAt: null });
			const record = await FloatStamped.get('f13');
			assert.strictEqual(record.updatedAt, record.getUpdatedTime());
		});

		it('a wrongly-typed timestamp value is rejected by validation before the stamp would replace it', async () => {
			const error = await rejection(() => FloatStamped.put('f8', { id: 'f8', name: 'a', updatedAt: '2020-01-01' }));
			assert.match(error.message, /updatedAt must be a number/);
			assert.strictEqual(await FloatStamped.get('f8'), null);
		});

		it('an unparseable string for a Date timestamp is coerced, not rejected, then overwritten', async () => {
			await DateStamped.put('d2', { id: 'd2', name: 'a', updatedAt: 'not a date' });
			const record = await DateStamped.get('d2');
			assert.strictEqual(record.updatedAt.getTime(), Math.trunc(record.getUpdatedTime()));
		});
	});

	describe('replicated writes', () => {
		it('keep the timestamps the originating node stamped; nothing is re-stamped locally', async () => {
			const originUpdated = Date.now() - 60_000;
			const originCreated = originUpdated - 60_000;
			// The receiver's context carries source/sourceApply; context.source is what skips the stamp.
			const context = { source: {}, sourceApply: true, timestamp: originUpdated };
			await transaction(context, async () => {
				const resource = await FloatStamped.getResource('f9', context);
				return resource._writeUpdate(
					'f9',
					{ id: 'f9', name: 'replicated', createdAt: originCreated, updatedAt: originUpdated },
					true,
					{ isNotification: true, nodeId: 1, version: originUpdated }
				);
			});
			const record = await FloatStamped.get('f9');
			assert.strictEqual(record.name, 'replicated');
			assert.strictEqual(record.updatedAt, originUpdated);
			assert.strictEqual(record.createdAt, originCreated);
		});
	});
});

describe('code-first types.date.updatedTime / createdTime', () => {
	let CodeFirst;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		CodeFirst = defineTable(
			'TsCodeFirst',
			{
				id: types.id.primaryKey,
				name: types.string.nullable,
				createdAt: types.date.createdTime,
				updatedAt: types.date.updatedTime,
			},
			{ database: DB }
		);
	});

	it('compiles to the same attribute flags as GraphQL `Date @updatedTime`, never marked required', () => {
		const byName = Object.fromEntries(CodeFirst.attributes.map((attribute) => [attribute.name, attribute]));
		assert.strictEqual(byName.updatedAt.type, 'Date');
		assert.strictEqual(byName.updatedAt.assignUpdatedTime, true);
		assert.strictEqual(byName.updatedAt.nullable, undefined);
		assert.strictEqual(byName.createdAt.type, 'Date');
		assert.strictEqual(byName.createdAt.assignCreatedTime, true);
		assert.strictEqual(byName.createdAt.nullable, undefined);
		assert.strictEqual(CodeFirst.updatedTimeProperty.name, 'updatedAt');
		assert.strictEqual(CodeFirst.createdTimeProperty.name, 'createdAt');
	});

	it('stamps through the same Table write path: Date values, caller values overwritten', async () => {
		await CodeFirst.put('c1', { id: 'c1', name: 'a', updatedAt: new Date(0), createdAt: new Date(0) });
		const record = await CodeFirst.get('c1');
		assert.strictEqual(record.updatedAt.getTime(), Math.trunc(record.getUpdatedTime()));
		assert.strictEqual(record.createdAt.getTime(), record.updatedAt.getTime());
	});

	it('a table-derived request contract omits server-managed fields and rejects a body that sends one', async () => {
		let ran = false;
		const Api = defineResource(
			{ path: '/ts-code-first', post: { body: schemaOf({ table: CodeFirst, projection: 'insert' }) } },
			{
				async post(_target, data) {
					ran = true;
					return data;
				},
			}
		);
		const error = await rejection(() =>
			Api.post(new RequestTarget(), {
				name: 'a',
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})
		);
		assert.strictEqual(error.name, 'ValidationError');
		for (const path of ['body.createdAt', 'body.updatedAt']) {
			assert.ok(
				error.errors.some((issue) => issue.path === path),
				JSON.stringify(error.errors)
			);
		}
		assert.strictEqual(ran, false);
	});
});

describe('GraphQL non-null timestamp field (`Date! @updatedTime`)', () => {
	let RequiredStamp;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		await loadGQLSchema(`
			type TsRequired @table(database: "${DB}") {
				id: ID @primaryKey
				updatedAt: Date! @updatedTime
			}
		`);
		RequiredStamp = databases[DB].TsRequired;
	});

	it('rejects a put that omits the field: validation runs before the stamp is applied', async () => {
		// Known defect; code-first never marks a server-managed field required.
		const error = await rejection(() => RequiredStamp.put('r1', { id: 'r1' }));
		assert.match(error.message, /updatedAt is required/);
	});

	it('accepts a patch that omits the field (patch validates only the fields it sends) and stamps it', async () => {
		await RequiredStamp.patch('r2', {});
		const record = await RequiredStamp.get('r2');
		assert.strictEqual(record.updatedAt.getTime(), Math.trunc(record.getUpdatedTime()));
	});
});

// Through v5.2.x a fill stamped updatedTime with the local commit time. Since v5.3.0 (ba81e7b04, #2065)
// the fill writes at the source's lastModified, capped at now, else at the fill's start timestamp, and
// stamps updatedTime with that version.
describe('caching table (sourcedFrom) fill', () => {
	let Cached;
	let sourceLastModified;
	let sourceRecord;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Cached = table({
			table: 'TsCached',
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'createdAt', type: 'Float', assignCreatedTime: true },
				{ name: 'updatedAt', type: 'Float', assignUpdatedTime: true },
			],
		});
		Cached.sourcedFrom({
			get(id, context) {
				if (sourceLastModified !== undefined) context.lastModified = sourceLastModified;
				return { id, ...sourceRecord };
			},
		});
	});

	// The version clock and Date.now() are different clock sources; the slack absorbs their drift.
	function assertNearNow(value, before) {
		assert.ok(value >= before - 1000 && value <= Date.now() + 1000, `${value} is not near now (${before})`);
	}

	// The filling get() can resolve before the fill commits, so assert on the stored record.
	async function fill(id) {
		await Cached.get(id);
		await waitFor(() => Cached.primaryStore.getSync(id));
		return Cached.get(id);
	}

	it('source sets context.lastModified: updatedTime is that time, not the local write time', async () => {
		sourceLastModified = Date.now() - 3_600_000;
		sourceRecord = { name: 'from source' };
		const record = await fill('k1');
		assert.strictEqual(record.updatedAt, sourceLastModified);
		assert.strictEqual(record.getUpdatedTime(), sourceLastModified);
		assert.strictEqual(record.createdAt, sourceLastModified);
	});

	it('source sets no lastModified: updatedTime is the fill version', async () => {
		sourceLastModified = undefined;
		sourceRecord = { name: 'from source' };
		const before = Date.now();
		const record = await fill('k2');
		assertNearNow(record.updatedAt, before);
		assert.strictEqual(record.updatedAt, record.getUpdatedTime());
	});

	it('source-returned updatedTime is overwritten; source-returned createdTime is kept', async () => {
		sourceLastModified = undefined;
		sourceRecord = { name: 'from source', createdAt: 123, updatedAt: 456 };
		const record = await fill('k3');
		assert.strictEqual(record.createdAt, 123);
		assert.strictEqual(record.updatedAt, record.getUpdatedTime());
	});

	it('source sets a future lastModified: updatedTime is capped at the fill time', async () => {
		sourceLastModified = Date.now() + 3_600_000;
		sourceRecord = { name: 'from source' };
		const before = Date.now();
		const record = await fill('k4');
		assertNearNow(record.updatedAt, before);
		assert.strictEqual(record.updatedAt, record.getUpdatedTime());
	});
});
