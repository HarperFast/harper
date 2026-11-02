const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { publishOriginFloor, reserveLocalKey, releaseLocalKey } = require('#src/resources/originClosedFloor');
const { recordUpdater } = require('#src/resources/RecordEncoder');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const add = (value) => ({ __op__: 'add', value });

describe('Resolved audit references fold once', function () {
	this.timeout(30000);
	const keys = Array.from({ length: 200 }, (_, index) => `key-${index}`);
	const orders = [
		[0, 1, 2, 3],
		[0, 3, 2, 1],
		[0, 2, 3, 1],
	];
	let receivers;
	const createTable = (database) =>
		table({ table: 'Counters', database, attributes: [{ name: 'id', isPrimaryKey: true }], audit: true });

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		receivers = orders.map((order, index) => {
			const T = createTable(`visitedAuditRefs${index}`);
			const origins = ['fold-a', 'fold-b', 'fold-c'].map((name) => getIdOfRemoteNode(name, T.auditStore));
			return { T, origins, order };
		});
	});

	async function apply({ T, origins }, write, timestamp, prefix) {
		const context = { source: {}, sourceApply: true, timestamp };
		await transaction(context, async () => {
			for (const key of keys) {
				const id = `${prefix}-${key}`;
				const resource = await T.getResource(id, context);
				await resource._writeUpdate(id, { ...(write.put ? { id } : {}), ...write.value }, write.put ?? false, {
					isNotification: true,
					nodeId: origins[write.origin],
					version: timestamp,
				});
			}
		});
	}

	for (const latePut of [false, true]) {
		it(`converges for three origins and 200 keys with a late ${latePut ? 'put' : 'patch'}`, async function () {
			const base = Date.now() + (latePut ? 7_200_000 : 3_600_000);
			const prefix = latePut ? 'put' : 'patch';
			const writes = [
				{ origin: 0, put: true, value: { count: 0, label: 'seed', omitted: true } },
				{ origin: 1, put: latePut, value: { count: latePut ? 100 : add(7), label: 'older' } },
				{ origin: 2, value: { count: add(3), label: 'middle' } },
				{ origin: 0, value: { count: add(5), label: 'newest' } },
			];
			const snapshots = [];
			for (const receiver of receivers) {
				for (const index of receiver.order) await apply(receiver, writes[index], base + index * 1000, prefix);
				const expectedCount = latePut ? 108 : 15;
				const snapshot = [];
				for (const key of keys) {
					const id = `${prefix}-${key}`;
					const expected = { id, count: expectedCount, label: 'newest', ...(latePut ? {} : { omitted: true }) };
					const actual = { ...(await receiver.T.get(id)) };
					assert.deepStrictEqual(actual, expected, `${id}: arrival ${receiver.order.join(',')}`);
					assert.deepStrictEqual({ ...receiver.T.primaryStore.getEntry(id).value }, expected);
					snapshot.push(actual);
				}
				assert.strictEqual(snapshot.length, 200);
				snapshots.push(snapshot);
				if (isLMDB) continue; // Re-delivery also increments on unmodified LMDB.
				await apply(receiver, writes[2], base + 2000, prefix);
				for (const key of keys) {
					assert.strictEqual(
						(await receiver.T.get(`${prefix}-${key}`)).count,
						expectedCount,
						're-delivery adds nothing'
					);
				}
			}
			assert.deepStrictEqual(snapshots[1], snapshots[0]);
			assert.deepStrictEqual(snapshots[2], snapshots[0]);
		});
	}

	for (const targetFirst of [true, false]) {
		it(`does not charge a visited local frame again (target ${targetFirst ? 'first' : 'last'})`, async function () {
			if (isLMDB) return this.skip();
			const T = createTable(`visitedAuditRefsLargeFrame${targetFirst}`);
			publishOriginFloor(T.primaryStore.rootStore, Date.now() + 3_600_000);
			await T.put('key-0', { count: 0, omitted: true });
			const seed = T.primaryStore.getEntry('key-0').version;
			publishOriginFloor(T.primaryStore.rootStore, seed + 4000);
			await transaction({}, async () => {
				if (targetFirst) await T.patch('key-0', { count: add(5), label: 'newest' });
				for (let index = 1; index < 600; index++) await T.put(`filler-${index}`, { count: index });
				if (!targetFirst) await T.patch('key-0', { count: add(5), label: 'newest' });
			});
			const head = T.primaryStore.getEntry('key-0');
			assert.strictEqual(head.nodeId ?? 0, 0);
			assert.strictEqual(T.auditStore.get(head.version, T.tableId, 'key-0', 0).txnLogKey, head.version);
			assert.ok(!head.additionalAuditRefs?.length);
			const middleOrigin = getIdOfRemoteNode('large-frame-middle', T.auditStore);
			const olderOrigin = getIdOfRemoteNode('large-frame-older', T.auditStore);
			async function deliver(record, nodeId, timestamp, fullUpdate) {
				const context = { source: {}, sourceApply: true, timestamp };
				await transaction(context, async () => {
					const resource = await T.getResource('key-0', context);
					await resource._writeUpdate('key-0', record, fullUpdate, {
						isNotification: true,
						nodeId,
						version: timestamp,
					});
				});
			}
			await deliver({ count: add(3), label: 'middle' }, middleOrigin, seed + 3000, false);
			assert.strictEqual((await T.get('key-0')).count, 8);
			await deliver({ id: 'key-0', count: 100 }, olderOrigin, seed + 2000, true);
			assert.deepStrictEqual({ ...(await T.get('key-0')) }, { id: 'key-0', count: 108, label: 'newest' });
		});
	}

	it('does not treat a failed qualified lookup as a resolved audit entry', async function () {
		if (isLMDB) return this.skip();
		const T = createTable('visitedAuditRefsQualifiedMiss');
		const root = T.primaryStore.rootStore;
		const [historical, middle, older] = ['historical', 'middle', 'older'].map((name) =>
			getIdOfRemoteNode(`qualified-miss-${name}`, T.auditStore)
		);
		publishOriginFloor(root, Date.now() + 3_600_000);
		await T.put('key-0', { label: 'seed' });
		const seed = T.primaryStore.getEntry('key-0');
		let headKey;
		let middleKey;
		for (const isHead of [true, false]) {
			publishOriginFloor(root, isHead ? seed.version + 4000 : headKey + 1000);
			let handle;
			try {
				await root.transaction((native) => {
					handle = native;
					const logKey = reserveLocalKey(root, native);
					if (isHead) headKey = logKey;
					else middleKey = logKey;
					// Historical unnamed-origin entries can remain in local after the origin gains a name.
					T.auditStore.put(
						null,
						{
							type: 'patch',
							tableId: T.tableId,
							recordId: 'key-0',
							nodeId: isHead ? historical : middle,
							version: isHead ? headKey : headKey - 1000,
							previousVersion: isHead ? seed.version : headKey,
							encodedRecord: Buffer.from(
								T.primaryStore.encoder.encode(isHead ? { label: 'newest' } : { middle: true })
							),
						},
						{ transaction: native, nodeId: isHead ? undefined : middle }
					);
					if (!isHead)
						recordUpdater(T.primaryStore, T.tableId, T.auditStore)(
							'key-0',
							{ id: 'key-0', middle: true, label: 'newest' },
							seed,
							headKey,
							0,
							false,
							{
								transaction: native,
								nodeId: historical,
								additionalAuditRefs: [
									{ version: headKey, nodeId: historical },
									{ version: middleKey, nodeId: middle },
								],
							}
						);
				});
			} finally {
				if (handle) releaseLocalKey(handle);
			}
		}
		assert.strictEqual(T.primaryStore.getEntry('key-0').nodeId, historical);
		assert.strictEqual(T.primaryStore.getEntry('key-0').version, headKey);
		assert.strictEqual(T.auditStore.get(headKey, T.tableId, 'key-0', historical), undefined);
		const head = T.auditStore.get(headKey, T.tableId, 'key-0');
		assert.strictEqual(head.nodeId, historical);
		assert.deepStrictEqual(head.getValue(T.primaryStore), { label: 'newest' });
		assert.deepStrictEqual(T.auditStore.get(middleKey, T.tableId, 'key-0', middle).getValue(T.primaryStore), {
			middle: true,
		});
		const context = { source: {}, sourceApply: true, timestamp: headKey - 2000 };
		assert.ok(context.timestamp > seed.version);
		await transaction(context, async () => {
			const resource = await T.getResource('key-0', context);
			await resource._writeUpdate('key-0', { retained: 'older', label: 'older' }, false, {
				isNotification: true,
				nodeId: older,
				version: context.timestamp,
			});
		});
		assert.deepStrictEqual(
			{ ...(await T.get('key-0')) },
			{ id: 'key-0', middle: true, retained: 'older', label: 'newest' }
		);
	});

	it('bounds a previously unseen unknown frame whose target is past the walk limit', async function () {
		if (isLMDB) return this.skip();
		const T = createTable('visitedAuditRefsUnknownCap');
		publishOriginFloor(T.primaryStore.rootStore, Date.now() + 3_600_000);
		await T.put('key-0', { count: 0, omitted: true });
		const seed = T.primaryStore.getEntry('key-0').version;
		publishOriginFloor(T.primaryStore.rootStore, seed + 4000);
		await transaction({}, async () => {
			for (let index = 1; index < 1100; index++) await T.put(`filler-${index}`, { count: index });
			await T.patch('key-0', { count: add(5), label: 'middle' });
		});
		const largeFrame = T.primaryStore.getEntry('key-0').version;
		const newer = getIdOfRemoteNode('unknown-cap-newer', T.auditStore);
		const older = getIdOfRemoteNode('unknown-cap-older', T.auditStore);
		async function deliver(record, nodeId, timestamp, fullUpdate) {
			const context = { source: {}, sourceApply: true, timestamp };
			await transaction(context, async () => {
				const resource = await T.getResource('key-0', context);
				await resource._writeUpdate('key-0', record, fullUpdate, { isNotification: true, nodeId, version: timestamp });
			});
		}
		await deliver({ count: add(3), label: 'newest' }, newer, seed + 5000, false);
		const originalGetRange = T.auditStore.getRange;
		let unknownEntries = 0;
		try {
			T.auditStore.getRange = function (options) {
				const range = originalGetRange.call(this, options);
				if (options.start !== largeFrame || options.log !== undefined) return range;
				return {
					*[Symbol.iterator]() {
						for (const entry of range) {
							unknownEntries++;
							yield entry;
						}
					},
				};
			};
			await deliver({ id: 'key-0', count: 100, label: 'older' }, older, seed + 2000, true);
		} finally {
			T.auditStore.getRange = originalGetRange;
		}
		assert.ok(unknownEntries > 0 && unknownEntries <= 1001, `unknown frame yielded ${unknownEntries} entries`);
		const record = await T.get('key-0');
		assert.strictEqual(record.label, 'newest');
		assert.strictEqual(record.omitted, true, 'a capped walk retains the existing merge fallback');
	});
});
