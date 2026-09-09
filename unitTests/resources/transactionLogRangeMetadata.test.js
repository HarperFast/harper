const assert = require('node:assert');
const { RocksTransactionLogStore } = require('#src/resources/RocksTransactionLogStore');
const { createAuditEntry, ENTRY_DATAVIEW } = require('#src/resources/auditStore');

function encodedDelete(recordId) {
	ENTRY_DATAVIEW.setUint32(0, 0);
	return Buffer.from(
		createAuditEntry(
			{
				type: 'delete',
				tableId: 1,
				recordId,
				nodeId: 0,
				version: 100,
			},
			4
		)
	);
}

function makeLog(name, entries) {
	return {
		name,
		query() {
			let index = 0;
			return {
				next() {
					return index < entries.length ? { value: entries[index++], done: false } : { value: undefined, done: true };
				},
				[Symbol.iterator]() {
					return this;
				},
			};
		},
	};
}

function makeStore(logs) {
	const byName = new Map(logs.map((log) => [log.name, log]));
	const rootStore = {
		path: '/transaction-log-range-metadata-test',
		useLog: (name) => byName.get(name) ?? logs[0],
		listLogs: () => logs.map((log) => log.name),
		on() {},
	};
	const store = new RocksTransactionLogStore(rootStore);
	store.nodeLogs = logs;
	store.logByName = byName;
	return store;
}

function entry(timestamp, recordId) {
	return { timestamp, data: encodedDelete(recordId), endTxn: true };
}

describe('RocksTransactionLogStore range metadata', () => {
	it('preserves the physical log name on aggregate and single-log results when requested', () => {
		const local = makeLog('local', [entry(20, 'local-record')]);
		const peer = makeLog('peer-a', [entry(10, 'peer-record')]);
		const store = makeStore([local, peer]);

		const aggregate = [...store.getRange({ includeLogName: true })];
		assert.deepStrictEqual(
			aggregate.map(({ recordId, logName }) => [recordId, logName]),
			[
				['peer-record', 'peer-a'],
				['local-record', 'local'],
			]
		);

		const single = [...store.getRange({ log: 'peer-a', includeLogName: true })];
		assert.strictEqual(single.length, 1);
		assert.strictEqual(single[0].logName, 'peer-a');
	});

	it('keeps logName in the audit-record shape without populating it by default', () => {
		const store = makeStore([makeLog('local', [entry(10, 'record')])]);
		const iterable = store.getRange({});
		const [record] = iterable;

		assert(Object.prototype.hasOwnProperty.call(record, 'logName'));
		assert.strictEqual(record.logName, undefined);
		assert.strictEqual(iterable.failedLogs.size, 0);
	});

	it('keeps logName in malformed-entry sentinels with and without source metadata', () => {
		const malformed = { timestamp: 10, data: new Uint8Array(2), endTxn: true };
		const store = makeStore([makeLog('local', [malformed])]);
		const [defaultRecord] = store.getRange({});
		const [namedRecord] = store.getRange({ includeLogName: true });

		assert(Object.prototype.hasOwnProperty.call(defaultRecord, 'logName'));
		assert.strictEqual(defaultRecord.logName, undefined);
		assert(Object.prototype.hasOwnProperty.call(namedRecord, 'logName'));
		assert.strictEqual(namedRecord.logName, 'local');
	});

	it('reports the physical log when an unexpected iterator failure is contained', () => {
		const failedLog = makeLog('failed-peer', []);
		failedLog.query = () => ({
			next() {
				throw new Error('unexpected read failure');
			},
			[Symbol.iterator]() {
				return this;
			},
		});
		const healthyLog = makeLog('local', [entry(10, 'record')]);
		const iterable = makeStore([failedLog, healthyLog]).getRange({ includeLogName: true });

		assert.deepStrictEqual(
			[...iterable].map(({ recordId, logName }) => [recordId, logName]),
			[['record', 'local']]
		);
		assert.deepStrictEqual([...iterable.failedLogs], ['failed-peer']);
	});
});
