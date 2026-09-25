// harper#1162: an origin with no log here files its entries in the relaying peer's log.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const auditStoreModule = require('#src/resources/auditStore');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Re-delivered writes relayed from an origin with no log here', () => {
	let Relayed, auditStore, originId, relayId, otherRelayId;
	let lastLogKey = Date.now() - 60_000;
	const originClock = () => (lastLogKey += 1_000);

	function entriesFor(id, type) {
		const entries = [];
		for (const auditRecord of auditStore.getRange({ start: 1 })) {
			if (auditRecord.tableId === Relayed.tableId && auditRecord.recordId === id && auditRecord.type === type)
				entries.push(auditRecord);
		}
		return entries;
	}

	function applyRelayed(logKey, type, id, viaNodeId = relayId) {
		const context = { source: {}, sourceApply: true, timestamp: logKey };
		return transaction(context, async () => {
			const options = { isNotification: true, nodeId: originId, viaNodeId, version: logKey };
			const resource = await Relayed.getResource(id, context);
			if (type === 'delete') resource._writeDelete(id, options);
			else resource._writeUpdate(id, { id, name: id }, true, options);
		});
	}

	before(function () {
		if (isLMDB) return this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		Relayed = table({
			table: 'RelayedDuplicateLookup',
			database: 'relayed-duplicate-lookup',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
		auditStore = Relayed.primaryStore.rootStore.auditStore;
		originId = getIdOfRemoteNode('relayed-origin-without-log', auditStore);
		const nodeLogs = auditStore.loadLogs();
		auditStore.ensureLogExists('relay-peer-with-log');
		// the id the store filed the log under (another suite may have replaced the id mapping)
		relayId = nodeLogs.indexOf(auditStore.logByName.get('relay-peer-with-log'));
		auditStore.ensureLogExists('other-relay-peer');
		otherRelayId = nodeLogs.indexOf(auditStore.logByName.get('other-relay-peer'));
	});

	it('logs a re-delivered relayed put once', async () => {
		const logKey = originClock();
		for (let i = 0; i < 5; i++) await applyRelayed(logKey, 'put', 'relayed-put');
		assert.equal(entriesFor('relayed-put', 'put').length, 1);
	});

	it('logs a re-delivered relayed delete once', async () => {
		await applyRelayed(originClock(), 'put', 'relayed-delete');
		const logKey = originClock();
		for (let i = 0; i < 5; i++) await applyRelayed(logKey, 'delete', 'relayed-delete');
		assert.equal(entriesFor('relayed-delete', 'delete').length, 1);
	});

	it('logs a re-delivered relayed put once when the nominal retention floor is past its log key', async () => {
		const retention = auditStoreModule.auditRetention;
		auditStoreModule.setAuditRetention(1);
		try {
			const logKey = originClock();
			for (let i = 0; i < 5; i++) await applyRelayed(logKey, 'put', 'relayed-short-retention');
			assert.equal(entriesFor('relayed-short-retention', 'put').length, 1);
		} finally {
			auditStoreModule.setAuditRetention(retention);
		}
	});

	it('logs a relayed put once when its re-delivery comes through another relay', async () => {
		const logKey = originClock();
		await applyRelayed(logKey, 'put', 'relayed-other-route');
		for (let i = 0; i < 4; i++) await applyRelayed(logKey, 'put', 'relayed-other-route', otherRelayId);
		assert.equal(entriesFor('relayed-other-route', 'put').length, 1);
	});

	it('creates no log for the origin while looking up its entries', async () => {
		await applyRelayed(originClock(), 'put', 'relayed-no-log');
		assert.equal(auditStore.logById(originId), undefined);
	});
});
