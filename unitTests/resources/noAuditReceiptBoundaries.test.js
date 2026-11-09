require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { waitFor } = require('../waitFor');

describe('audit:false receipts across invalidate and replacement', () => {
	let nextTable = 0;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	async function receiptTable() {
		const Table = table({
			database: 'noAuditReceiptBoundaries',
			table: `NoAuditReceiptBoundary${++nextTable}`,
			audit: false,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'count', indexed: true },
				{ name: 'tag', indexed: true },
			],
		});
		await Table.indexingOperation;
		return Table;
	}

	function apply(Table, timestamp, writes) {
		const nodeId = getIdOfRemoteNode('receipt-reset-origin', Table.auditStore);
		const context = { source: {}, sourceApply: true, timestamp };
		return transaction(context, async () => {
			for (const [value, fullUpdate] of writes) {
				const resource = await Table.getResource('counter', context);
				await resource._writeUpdate('counter', value, fullUpdate, {
					nodeId,
					version: timestamp + 1,
					isNotification: true,
				});
			}
		});
	}

	for (const ending of ['invalidate', 'put']) {
		for (const trailingPatch of [false, true]) {
			it(`deduplicates a sourced [add, ${ending}${trailingPatch ? ', patch' : ''}] transaction`, async () => {
				const Table = await receiptTable();
				const nodeId = getIdOfRemoteNode('receipt-boundary-origin', Table.auditStore);
				const start = Date.now() + 60_000;
				const expected = ending === 'put' ? 20 : 13;
				const frame = (timestamp, writes) => ({
					type: 'transaction',
					timestamp,
					writes: writes.map((write) => ({ ...write, nodeId, version: timestamp + 1 })),
				});
				const delivery = () =>
					frame(start + 10, [
						{ type: 'patch', id: 'counter', value: { count: { __op__: 'add', value: 3 } } },
						{ type: ending, id: 'counter', value: ending === 'put' ? { id: 'counter', count: 20 } : undefined },
						...(trailingPatch ? [{ type: 'patch', id: 'counter', value: { tag: 'tail' } }] : []),
					]);
				let replay;
				let finish;
				let sourceStopped = false;
				const replayGate = new Promise((resolve) => (replay = resolve));
				const finishGate = new Promise((resolve) => (finish = resolve));
				Table.sourcedFrom(
					{
						isReplicator: true,
						subscribeOnThisThread: () => true,
						async *subscribe() {
							try {
								yield frame(start, [{ type: 'put', id: 'counter', value: { id: 'counter', count: 10 } }]);
								yield delivery();
								yield delivery();
								yield frame(start + 20, [{ type: 'put', id: 'first-marker', value: { id: 'first-marker' } }]);
								await replayGate;
								yield frame(start + 30, [{ type: 'patch', id: 'counter', value: { tag: 'newer' } }]);
								yield delivery();
								yield frame(start + 40, [{ type: 'put', id: 'last-marker', value: { id: 'last-marker' } }]);
								await finishGate;
							} finally {
								sourceStopped = true;
							}
						},
					},
					{ intermediateSource: true }
				);
				try {
					await waitFor(() => Table.primaryStore.getEntry('first-marker')?.value, {
						timeout: 5000,
						message: 'the first delivery should commit',
					});
					assert.equal(Table.primaryStore.getEntry('counter').value.count, expected);
					replay();
					await waitFor(() => Table.primaryStore.getEntry('last-marker')?.value, {
						timeout: 5000,
						message: 'the replay should commit',
					});
					const entry = Table.primaryStore.getEntry('counter');
					assert.equal(entry.value.count, expected, 're-delivery applied the leading add twice');
					assert.equal(entry.value.tag, 'newer');
					assert.deepEqual(entry.receivedIdentityRefs, [{ version: start + 10, nodeId }]);
				} finally {
					replay();
					finish();
					await waitFor(() => sourceStopped, { timeout: 5000, message: 'the source should close' });
				}
			});
		}
	}

	it('an invalidate in a later transaction keeps committed receipts', async () => {
		const Table = await receiptTable();
		await Table.put('counter', { count: 10 });
		const start = Date.now() + 60_000;
		const add = [[{ count: { __op__: 'add', value: 3 } }, false]];
		await apply(Table, start, add);
		const context = { timestamp: start + 10 };
		await transaction(context, async () => {
			const resource = await Table.getResource('counter', context);
			await resource._writeInvalidate('counter');
		});
		await apply(Table, start + 20, [[{ tag: 'newer' }, false]]);
		await apply(Table, start, add);
		assert.equal(Table.primaryStore.getEntry('counter').value.count, 13);
	});

	it('a copied invalidation snapshot still resets receipts from the replaced body', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const Table = await receiptTable();
		await Table.put('counter', { count: 10 });
		const start = Date.now() + 60_000;
		const add = [[{ count: { __op__: 'add', value: 3 } }, false]];
		await apply(Table, start, add);
		const context = { source: {}, sourceApply: true, timestamp: start + 10 };
		await transaction(context, async () => {
			const resource = await Table.getResource('counter', context);
			await resource._writeInvalidate('counter', { count: 20 }, { isCopyApply: true });
		});
		assert.equal(Table.primaryStore.getEntry('counter').receivedIdentityRefs, undefined);
		await apply(Table, start, add);
		assert.equal(Table.primaryStore.getEntry('counter').value.count, 23);
	});

	it('a replacement re-applied after an LMDB version rewind keeps its committed receipt', async function () {
		if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') return this.skip();
		const Table = await receiptTable();
		await Table.put('counter', { count: 0 });
		const start = Date.now() + 60_000;
		const writes = [
			[{ count: { __op__: 'add', value: 5 } }, false],
			[{ id: 'counter', count: 10 }, true],
		];
		await apply(Table, start, writes);
		await apply(Table, start - 10, [[{ count: { __op__: 'add', value: 1 } }, false]]);
		assert.equal(Table.primaryStore.getEntry('counter').version, start - 10);
		await apply(Table, start, writes);
		await apply(Table, start + 50, [[{ tag: 'newer' }, false]]);
		await apply(Table, start, writes);
		assert.equal(Table.primaryStore.getEntry('counter').value.count, 10);
	});

	it('a native recommit keeps the receipt across a replacement', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		const Table = await receiptTable();
		await Table.put('counter', { count: 10 });
		await Table.put('other', { count: 0 });
		const start = Date.now() + 60_000;
		const nodeId = getIdOfRemoteNode('receipt-reset-origin', Table.auditStore);
		const context = { source: {}, sourceApply: true, timestamp: start };
		const options = { isNotification: true, nodeId, version: start + 1 };
		const writes = [
			[{ count: { __op__: 'add', value: 3 } }, false],
			[{ id: 'counter', count: 20 }, true],
		];
		let native;
		await transaction(context, async () => {
			for (const [value, fullUpdate] of writes) {
				const resource = await Table.getResource('counter', context);
				await resource._writeUpdate('counter', value, fullUpdate, options);
				await context.transaction.save(context.transaction.writes.filter((write) => write.key === 'counter').at(-1));
			}
			const other = await Table.getResource('other', context);
			await other._writeUpdate('other', { count: 1 }, false, options);
			await context.transaction.save(context.transaction.writes.find((write) => write.key === 'other'));
			native = context.transaction.transaction;
			await transaction({}, () => Table.put('other', { count: 2 }));
		});
		assert.ok(native.retries > 0, 'the other key must force a real native recommit');
		await apply(Table, start + 50, [[{ tag: 'newer' }, false]]);
		await apply(Table, start, writes);
		assert.equal(Table.primaryStore.getEntry('counter').value.count, 20);
	});

	for (const leadingAdd of [false, true]) {
		it(`a replacement resets older receipts${leadingAdd ? ' but keeps its leading add' : ' after a plain patch'}`, async () => {
			const Table = await receiptTable();
			const nodeId = getIdOfRemoteNode('receipt-reset-origin', Table.auditStore);
			const start = Date.now() + 60_000;
			await Table.put('counter', { count: 10 });

			await apply(Table, start, [[{ count: { __op__: 'add', value: 1 } }, false]]);
			await apply(Table, start + 10, [
				[leadingAdd ? { count: { __op__: 'add', value: 3 } } : { tag: 'plain' }, false],
				[{ id: 'counter', count: 20 }, true],
				[{ tag: 'tail' }, false],
			]);
			assert.equal(Table.primaryStore.getEntry('counter').value.count, 20);
			assert.deepEqual(
				Table.primaryStore.getEntry('counter').receivedIdentityRefs,
				leadingAdd ? [{ version: start + 10, nodeId }] : undefined
			);
		});
	}
});
