require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table } = require('#src/resources/databases');
const { Resource, NOT_HANDLED, primitiveIdGetFor, registerPrimitiveIdGet } = require('#src/resources/Resource');
const { transaction } = require('#src/resources/transaction');
const { suspendDatabaseCommits } = require('#src/resources/DatabaseTransaction');
const {
	claimDatabaseDropPreparation,
	releaseDatabaseDropPreparation,
} = require('#src/resources/databaseDropPreparation');
const { addAnalyticsListener, checkAnalyticsEnabled, setAnalyticsEnabled } = require('#src/resources/analytics/write');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { ServerError } = require('#src/utility/errors/hdbError');

const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';

// `Table.get({ id })` always takes the instance dispatch, so it is the reference for `Table.get(id)`.
describe('Table.get by a primitive id', function () {
	this.timeout(20_000);
	let Records, Restricted, AttributeRestricted, records;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Records = table({
			table: 'PrimitiveIdGet',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'secret' }],
		});
		records = [
			{ id: 'a', name: 'A', secret: 'sa' },
			{ id: 3, name: 'three', secret: 's3' },
			{ id: 0, name: 'zero', secret: 's0' },
			{ id: '', name: 'empty', secret: 'se' },
		];
		for (const record of records) await Records.put(record);
		Restricted = {
			role: {
				permission: { test: { tables: { PrimitiveIdGet: { read: false } } } },
			},
		};
		AttributeRestricted = {
			role: {
				permission: {
					test: {
						tables: {
							PrimitiveIdGet: { read: true, attribute_permissions: [{ attribute_name: 'name', read: true }] },
						},
					},
				},
			},
		};
	});

	after(() => Records.dropTable());

	function inTransaction(callback) {
		return transaction(async (txn) => callback(txn.getContext()));
	}

	function countPrimitiveGets(TableClass) {
		const original = primitiveIdGetFor(TableClass);
		const calls = [];
		registerPrimitiveIdGet(TableClass, (...args) => {
			const result = original(...args);
			calls.push(result === NOT_HANDLED ? 'not-handled' : 'handled');
			return result;
		});
		calls.restore = () => registerPrimitiveIdGet(TableClass, original);
		return calls;
	}

	describe('equivalence with the instance dispatch', () => {
		it('serves hits through the registered getter with the same frozen record', async () => {
			const calls = countPrimitiveGets(Records);
			try {
				await inTransaction(async () => {
					for (const record of records) {
						const fast = Records.get(record.id);
						assert.ok(fast instanceof Promise);
						const general = await Records.get({ id: record.id });
						const value = await fast;
						assert.deepStrictEqual({ ...value }, record);
						assert.ok(Object.isFrozen(value));
						assert.strictEqual(value, general);
					}
				});
			} finally {
				calls.restore();
			}
			assert.deepStrictEqual([...calls], ['handled', 'handled', 'handled', 'handled']);
		});

		it('resolves a miss to null on both routes', async () => {
			const calls = countPrimitiveGets(Records);
			try {
				await inTransaction(async () => {
					assert.strictEqual(await Records.get('missing'), null);
					assert.strictEqual(await Records.get({ id: 'missing' }), null);
					assert.strictEqual(await Records.get(404), null);
				});
			} finally {
				calls.restore();
			}
			assert.deepStrictEqual([...calls], ['handled', 'handled']);
		});

		it('throws the same synchronous ClientError for an invalid id', () =>
			inTransaction(() => {
				for (const id of [NaN, 'x'.repeat(5000)]) {
					let fastError, generalError;
					try {
						Records.get(id);
					} catch (error) {
						fastError = error;
					}
					try {
						Records.get({ id });
					} catch (error) {
						generalError = error;
					}
					assert.ok(fastError, `get(${String(id).slice(0, 10)}) threw synchronously`);
					assert.strictEqual(fastError.message, generalError.message);
					assert.strictEqual(fastError.statusCode, 400);
				}
			}));

		it('reads its own transaction’s writes and records freshness on the context', async () => {
			await inTransaction(async (context) => {
				await Records.put({ id: 'staged', name: 'S' });
				// RocksDB reads a transaction's staged writes; LMDB reads the snapshot without them
				const staged = await Records.get('staged');
				const general = await Records.get({ id: 'staged' });
				assert.deepStrictEqual(staged && { ...staged }, general && { ...general });
				if (isRocksDB) assert.strictEqual(staged?.name, 'S');
				const { version } = Records.primaryStore.getEntry('a');
				context.lastModified = 0;
				await Records.get('a');
				assert.strictEqual(context.lastModified, version);
			});
			await Records.delete('staged');
		});

		it('evicts an expired record of a table without a source', async () => {
			const expiresAt = Date.now() - 1000;
			await Records.put({ id: 'expired-fast', name: 'E' }, { expiresAt });
			await Records.put({ id: 'expired-general', name: 'E' }, { expiresAt });
			const calls = countPrimitiveGets(Records);
			try {
				await inTransaction(async () => {
					assert.strictEqual(await Records.get('expired-fast'), null);
					assert.strictEqual(await Records.get({ id: 'expired-general' }), null);
				});
			} finally {
				calls.restore();
			}
			assert.deepStrictEqual([...calls], ['handled']);
		});

		it('records the same db-read analytics as the instance dispatch', async () => {
			const wasEnabled = checkAnalyticsEnabled();
			setAnalyticsEnabled(true);
			try {
				const reads = [];
				addAnalyticsListener((metrics) => {
					for (const metric of metrics)
						if (metric.metric === 'db-read' && metric.path === 'PrimitiveIdGet') reads.push(metric);
				});
				const waitForReport = async (count) => {
					await waitFor(() => reads.length >= count, { timeout: 10_000, message: 'no analytics report was flushed' });
					assert.strictEqual(reads.length, count);
				};
				await inTransaction(() => Records.get('a'));
				await waitForReport(1);
				await inTransaction(async () => {
					for (let i = 0; i < 20; i++) await Records.get(i % 2 ? 'a' : 3);
				});
				await waitForReport(2);
				await inTransaction(async () => {
					for (let i = 0; i < 20; i++) await Records.get({ id: i % 2 ? 'a' : 3 });
				});
				await waitForReport(3);
				const [, fast, general] = reads;
				assert.strictEqual(fast.count, 20);
				assert.deepStrictEqual(
					{ count: fast.count, mean: fast.mean, distribution: fast.distribution, method: fast.method },
					{ count: general.count, mean: general.mean, distribution: general.distribution, method: general.method }
				);
				setAnalyticsEnabled(false);
				await inTransaction(() => Records.get('a'));
				setAnalyticsEnabled(true);
				await inTransaction(() => Records.get('a'));
				await waitForReport(4);
				assert.strictEqual(reads[3].count, 1);
			} finally {
				setAnalyticsEnabled(wasEnabled);
			}
		});
	});

	describe('takes the instance dispatch', () => {
		async function assertNotHandled(TableClass, callback, context) {
			const calls = countPrimitiveGets(TableClass);
			try {
				return await callback(context);
			} finally {
				calls.restore();
				assert.ok(!calls.includes('handled'), `calls: ${calls}`);
			}
		}

		it('for a subclass, which has no registered getter', async () => {
			class Plain extends Records {}
			class CustomGet extends Records {
				get(target) {
					return { custom: target.id };
				}
			}
			assert.strictEqual(primitiveIdGetFor(Plain), undefined);
			await inTransaction(async () => {
				assert.deepStrictEqual({ ...(await Plain.get('a')) }, records[0]);
				assert.deepStrictEqual(await CustomGet.get('a'), { custom: 'a' });
			});
		});

		it('when authorization is requested', async () => {
			await assertNotHandled(Records, async () => {
				await assert.rejects(
					inTransaction((context) => {
						context.user = Restricted;
						context.authorize = true;
						return Records.get('a');
					}),
					/Unauthorized access/
				);
				const projected = await inTransaction((context) => {
					context.user = AttributeRestricted;
					context.authorize = true;
					return Records.get('a');
				});
				assert.strictEqual(projected.name, 'A');
				assert.strictEqual(projected.secret, undefined);
			});
		});

		it('when a dispatch hook was replaced after a fast read', async () => {
			await inTransaction(() => Records.get('a'));
			const original = Records.prototype.get;
			Records.prototype.get = function () {
				return 'replaced';
			};
			try {
				await assertNotHandled(Records, () =>
					inTransaction(async () => assert.strictEqual(await Records.get('a'), 'replaced'))
				);
			} finally {
				Records.prototype.get = original;
			}
			for (const [owner, name, calls] of [
				[Records, 'getResource', 1],
				[Resource, 'getResource', 1],
				[Records, '_updateResource', 1],
				[Records.prototype, '_loadRecord', 1],
				[Records.prototype, 'getRecord'],
				[Records.prototype, 'doesExist', 0],
			]) {
				const hook = owner[name];
				let called = 0;
				owner[name] = function (...args) {
					if (this === Records || this?.constructor === Records) called++;
					return hook.apply(this, args);
				};
				try {
					await assertNotHandled(Records, () =>
						inTransaction(async () => assert.strictEqual((await Records.get('a')).name, 'A'))
					);
				} finally {
					owner[name] = hook;
				}
				if (calls !== undefined) assert.strictEqual(called, calls, name);
				else assert.ok(called > 0, `${name} ran`);
			}
		});

		it('for loadAsInstance = false and getReturnMutable', async () => {
			Records.loadAsInstance = false;
			try {
				await assertNotHandled(Records, () =>
					inTransaction(async () => assert.strictEqual((await Records.get('a')).name, 'A'))
				);
			} finally {
				delete Records.loadAsInstance;
			}
			Records.getReturnMutable = true;
			try {
				await assertNotHandled(Records, () =>
					inTransaction(async () => assert.strictEqual((await Records.get('a')).getRecord().name, 'A'))
				);
			} finally {
				delete Records.getReturnMutable;
			}
		});

		it('for onlyIfCached, a third argument, and no open transaction', async () => {
			await assertNotHandled(Records, () =>
				inTransaction(async (context) => {
					context.onlyIfCached = true;
					// LMDB may prefetch first, so the 504 can arrive as a rejection rather than a throw
					await assert.rejects(
						async () => Records.get('missing'),
						(error) => error.statusCode === 504
					);
				})
			);
			const calls = countPrimitiveGets(Records);
			try {
				await inTransaction(async (context) =>
					assert.strictEqual((await Records.get('a', undefined, context)).name, 'A')
				);
			} finally {
				calls.restore();
			}
			assert.deepStrictEqual([...calls], []);
			await assertNotHandled(Records, async () => assert.strictEqual((await Records.get('a')).name, 'A'));
		});

		it('when the resolved context is itself a context provider', async () => {
			await inTransaction(async (context) => {
				let outerCalls = 0;
				let innerCalls = 0;
				const inner = {
					transaction: context.transaction,
					getContext() {
						innerCalls++;
						return undefined;
					},
				};
				const outer = {
					getContext() {
						outerCalls++;
						return inner;
					},
				};
				await assertNotHandled(Records, async () => assert.strictEqual((await Records.get('a', outer)).name, 'A'));
				const fastOuterCalls = outerCalls;
				const fastInnerCalls = innerCalls;
				outerCalls = innerCalls = 0;
				await Records.get({ id: 'a' }, outer);
				assert.strictEqual(fastOuterCalls, outerCalls);
				assert.strictEqual(fastInnerCalls, innerCalls);
			});
		});

		it('while commits are suspended or the database drop is being prepared', async () => {
			const suspension = suspendDatabaseCommits([Records.primaryStore.rootStore]);
			try {
				await assertNotHandled(Records, () => inTransaction(() => assert.throws(() => Records.get('a'))));
			} finally {
				suspension.release();
			}
			const rootPath = Records.primaryStore.rootStore.path;
			claimDatabaseDropPreparation(rootPath, 'primitive-id-get-test');
			try {
				await assertNotHandled(Records, () => inTransaction(() => assert.throws(() => Records.get('a'))));
			} finally {
				releaseDatabaseDropPreparation(rootPath, 'primitive-id-get-test');
			}
		});

		it('after the table is cleaned up', async () => {
			const Disposed = table({
				table: 'PrimitiveIdGetDisposed',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			});
			await Disposed.put({ id: 'a', name: 'A' });
			await Disposed.dropTable();
			await assertNotHandled(Disposed, () =>
				inTransaction(() =>
					assert.throws(
						() => Disposed.get('a'),
						(error) => error.statusCode === 404
					)
				)
			);
		});

		it('for a caching table', async () => {
			const Cached = table({
				table: 'PrimitiveIdGetCached',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			});
			Cached.sourcedFrom({ get: (id) => ({ id, name: 'from source' }) });
			try {
				await assertNotHandled(Cached, () =>
					inTransaction(async () => assert.strictEqual((await Cached.get('s')).name, 'from source'))
				);
			} finally {
				await Cached.dropTable();
			}
		});
	});

	describe('a resident load', () => {
		let Resident, load;
		before(async () => {
			Resident = table({
				table: 'PrimitiveIdGetResident',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				audit: true,
			});
			Resident.sourcedFrom(
				class extends Resource {
					static load(entry) {
						return load(entry);
					}
				},
				{ intermediateSource: true }
			);
		});
		after(() => Resident.dropTable());

		beforeEach(async () => {
			const context = {};
			await transaction(context, async () => {
				const resource = await Resident.getResource('stub', context, { ensureLoaded: false });
				resource._writeInvalidate('stub', Object.freeze({ name: 'stub' }), { residencyId: 123 });
			});
		});

		it('resolves with the resident’s record', async () => {
			load = async () => ({ key: 'stub', value: { id: 'stub', name: 'resident' }, metadataFlags: 0 });
			const calls = countPrimitiveGets(Resident);
			try {
				assert.strictEqual((await inTransaction(() => Resident.get('stub'))).name, 'resident');
			} finally {
				calls.restore();
			}
			assert.deepStrictEqual([...calls], ['handled']);
		});

		it('resolves a successful absence to null on both routes', async () => {
			load = async () => undefined;
			const calls = countPrimitiveGets(Resident);
			try {
				assert.strictEqual(await inTransaction(() => Resident.get('stub')), null);
			} finally {
				calls.restore();
			}
			assert.deepStrictEqual([...calls], ['handled']);
			assert.strictEqual(await inTransaction(() => Resident.get({ id: 'stub' })), null);
		});

		it('rejects the caller with the resident’s error', async () => {
			const unavailable = new ServerError('no resident is reachable', 502);
			load = async () => {
				throw unavailable;
			};
			await assert.rejects(
				inTransaction(() => Resident.get('stub')),
				(error) => error === unavailable
			);
		});

		it('authorizes after the load, as the instance dispatch does', async () => {
			let release;
			load = () =>
				new Promise((resolve) => {
					release = () => resolve({ key: 'stub', value: { id: 'stub', name: 'resident' }, metadataFlags: 0 });
				});
			for (const route of ['stub', { id: 'stub' }]) {
				await assert.rejects(
					inTransaction(async (context) => {
						const reading = Resident.get(route);
						await waitFor(() => release);
						context.user = {
							role: { permission: { test: { tables: { PrimitiveIdGetResident: { read: false } } } } },
						};
						context.authorize = true;
						release();
						return reading;
					}),
					/Unauthorized access/
				);
				release = undefined;
			}
		});
	});
});
