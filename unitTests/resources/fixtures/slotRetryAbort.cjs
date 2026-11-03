const assert = require('node:assert');
exports.snapshot = (Records, id = 'retry-abort') => {
	const row = Records.primaryStore.getEntry(id);
	return {
		slot: row?.residencySlot,
		version: row?.version,
		flags: row?.metadataFlags,
		value: row?.value,
		indexes: Object.fromEntries(
			['region', 'zone'].map((name) => [
				name,
				[...Records.indices[name].getRange({})].filter((entry) => entry.value === id),
			])
		),
	};
};
exports.audit = (Records, options = {}) =>
	[...Records.auditStore.getRange({ start: 1, log: 0, ...options })]
		.filter((e) => e.tableId === Records.tableId && e.recordId === 'retry-abort')
		.map((e) => ({
			type: e.type,
			slot: e.residencySlot,
			version: e.version,
			txnLogKey: e.txnLogKey,
			endTxn: e.endTxn,
			value: e.getValue(Records.primaryStore),
		}));
exports.abortMove = async (Records, api, expectRefusal = true) => {
	const { transaction, Transaction, constants, setResidencyPlacementGuard, replicationConfirmation } = api;
	const binding = Object.values(require.cache).find(
		(m) => m.filename?.endsWith('.node') && typeof m.exports.forceTryAgainForTesting === 'function'
	)?.exports;
	assert.ok(binding);
	const id = 'retry-abort';
	await Records.put(id, { id, region: 0, zone: 0, body: 'original' });
	const nativeCommit = Transaction.prototype.commit,
		nativeAbort = Transaction.prototype.abort;
	const attempts = [],
		aborts = [],
		confirmations = [];
	let originalId, admittedSlot;
	const context = { timestamp: Date.now() + 60_000 };

	Transaction.prototype.abort = function (...args) {
		const id = this.id;
		try {
			return nativeAbort.apply(this, args);
		} catch (e) {
			aborts.push({ id, code: e.code, message: e.message });
			throw e;
		}
	};
	Transaction.prototype.commit = function (...args) {
		if (this.store?.db !== Records.primaryStore.store.db) return nativeCommit.apply(this, args);
		attempts.push(this.id);
		const first = originalId === undefined;
		if (first) originalId = this.id;
		const result = nativeCommit.apply(this, args);
		if (!first) return result;
		const changeBase = () => transaction({}, () => Records.put(id, { id, region: 2, zone: 0, body: 'concurrent' }));
		return result.then(
			async (outcome) => {
				assert.equal(outcome, constants.RETRY_NOW_VALUE);
				await changeBase();
				return outcome;
			},
			async (error) => {
				assert.equal(error.code, 'ERR_TRY_AGAIN');
				await changeBase();
				throw error;
			}
		);
	};
	setResidencyPlacementGuard(() => {});
	replicationConfirmation((...args) => {
		confirmations.push(args);
		return Promise.resolve();
	});
	try {
		const pending = transaction(context, async () => {
			await Records.patch(id, { zone: 1 });
			const write = context.transaction.writes.find((w) => w?.key === id);
			admittedSlot = write.residencyOwnerSlot;
			assert.equal(admittedSlot, 0);
			binding.forceTryAgainForTesting(1);
		});
		if (expectRefusal) {
			await assert.rejects(
				pending,
				(error) =>
					error.statusCode === 409 &&
					error.retryable === true &&
					error.message.includes(Records.tableName) &&
					error.message.includes(id)
			);
			assert.equal(attempts.filter((id) => id === originalId).length, 1);
			assert.equal(Records.primaryStore.getEntry(id).value.zone, 0);
		} else {
			await pending;
			assert.ok(attempts.filter((id) => id === originalId).length >= 2);
			assert.equal(Records.primaryStore.getEntry(id).value.zone, 1);
		}
		return {
			originalId,
			admittedSlot,
			attempts,
			aborts,
			confirmations,
			primary: exports.snapshot(Records),
			committed: exports.audit(Records),
			uncommitted: exports.audit(Records, { readUncommitted: true }),
		};
	} finally {
		binding.forceTryAgainForTesting(0);
		Transaction.prototype.commit = nativeCommit;
		Transaction.prototype.abort = nativeAbort;
		setResidencyPlacementGuard(undefined);
		replicationConfirmation(undefined);
	}
};
