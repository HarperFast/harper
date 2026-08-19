'use strict';

require('../testUtils');
const { parentPort } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { table, databases, closeLoadedDatabases } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const {
	onMessageByType,
	getProcessInstanceId,
	sendToThreadWithStrictAcknowledgement,
} = require('#js/server/threads/manageThreads');

const MESSAGE_TYPE = 'drop-table-quiescence-test';
const CONTROL_TYPE = 'drop-table-quiescence-control';
let TestTable;
let aliasPreparations = 0;
let aliasClosedStores = false;
let releaseEmbed;
let releaseRead;
let releaseTransaction;

function report(event, details = {}) {
	parentPort.postMessage({ type: MESSAGE_TYPE, event, ...details });
}

function runWorkerFixture() {
	onMessageByType(CONTROL_TYPE, () => {});
	setupTestDBPath();

	process.on('unhandledRejection', (error) => {
		report('unhandled-rejection', { error: error?.stack ?? String(error) });
	});

	parentPort
		.on('message', async (message) => {
			if (message.type !== CONTROL_TYPE) return;
			try {
				switch (message.command) {
					case 'initialize': {
						aliasPreparations = 0;
						aliasClosedStores = false;
						const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'name' }];
						if (message.withEmbed) {
							attributes.push({ name: 'vector', type: 'Array', embed: { source: 'name', model: 'unused' } });
						}
						TestTable = table({
							table: message.table,
							database: message.database ?? 'test',
							attributes,
						});
						if (message.withAlias) {
							const aliasName = `${message.database ?? 'test'}_alias`;
							databases[aliasName] = {
								[message.table]: {
									primaryStore: TestTable.primaryStore,
									dbisDB: TestTable.dbisDB,
									async _prepareDrop({ closeStores }) {
										aliasPreparations++;
										aliasClosedStores ||= closeStores;
										if (closeStores) TestTable.primaryStore.close();
									},
								},
							};
						}
						if (message.withEmbed) {
							const embedGate = new Promise((resolve) => {
								releaseEmbed = resolve;
							});
							TestTable.setEmbedAttribute('vector', async () => {
								report('embed-entered');
								await embedGate;
								return [1, 2, 3];
							});
							TestTable.sourcedFrom({
								get: async (id) => ({ id, name: 'gated' }),
								available: () => true,
							});
						}

						if (typeof TestTable._prepareDrop === 'function') {
							const prepareDrop = TestTable._prepareDrop;
							TestTable._prepareDrop = async function (options) {
								report('prepare-entered');
								await prepareDrop.call(this, options);
								let handlesClosed = false;
								try {
									TestTable.primaryStore.getSync('__drop-close-probe__');
								} catch {
									handlesClosed = true;
								}
								report('prepare-finished', { handlesClosed });
							};
						}
						report('ready', { processInstanceId: getProcessInstanceId() });
						break;
					}
					case 'begin-source-read':
						TestTable.get(message.id, {}).then(
							() => report('source-read-resolved'),
							(error) => report('source-read-rejected', { error: error?.stack ?? String(error) })
						);
						break;
					case 'release-embed':
						releaseEmbed();
						break;
					case 'begin-transaction': {
						const context = {};
						const transactionGate = new Promise((resolve) => {
							releaseTransaction = resolve;
						});
						transaction(context, async () => {
							await TestTable.put({ id: message.id, name: 'pending' }, context);
							report('transaction-staged');
							await transactionGate;
						}).then(
							() => report('transaction-resolved'),
							(error) => report('transaction-rejected', { error: error?.stack ?? String(error) })
						);
						break;
					}
					case 'release-transaction':
						releaseTransaction();
						break;
					case 'begin-read': {
						const context = {};
						const readGate = new Promise((resolve) => {
							releaseRead = resolve;
						});
						transaction(context, async (dbTransaction) => {
							TestTable._readTxnForContext(context);
							const readTransaction = dbTransaction.useReadTxn();
							const iterator = TestTable.primaryStore
								.getRange({ start: false, transaction: readTransaction })
								[Symbol.iterator]();
							iterator.next();
							report('read-open');
							await readGate;
							try {
								iterator.next();
							} finally {
								iterator.return?.();
								dbTransaction.doneReadTxn();
							}
						}).then(
							() => report('read-resolved'),
							(error) => report('read-rejected', { error: error?.stack ?? String(error) })
						);
						break;
					}
					case 'release-read':
						releaseRead();
						break;
					case 'reject-prepare':
						TestTable._prepareDrop = async () => {
							report('prepare-entered');
							throw new Error('injected worker quiescence failure');
						};
						report('reject-prepare-armed');
						break;
					case 'send-foreign-strict':
						await sendToThreadWithStrictAcknowledgement(0, { type: 'resource_report', heapUsed: 1 }, 1000);
						report('foreign-strict-acknowledged');
						break;
					case 'drop-table': {
						const originalDropSync = TestTable.primaryStore.dropSync;
						if (message.interruptAfterColumnFamilyDrop) {
							TestTable.primaryStore.dropSync = function (...args) {
								originalDropSync.apply(this, args);
								throw new Error('injected interruption after column-family drop');
							};
						}
						try {
							await TestTable.dropTable();
							report('drop-result', { outcome: 'resolved', aliasPreparations, aliasClosedStores });
						} catch (error) {
							report('drop-result', {
								outcome: 'rejected',
								error: error?.stack ?? String(error),
								aliasPreparations,
								aliasClosedStores,
							});
						} finally {
							TestTable.primaryStore.dropSync = originalDropSync;
						}
						break;
					}
					case 'shutdown':
						closeLoadedDatabases();
						report('shutdown-complete');
						parentPort.unref();
						break;
				}
			} catch (error) {
				report('command-error', { command: message.command, error: error?.stack ?? String(error) });
			}
		})
		.ref();

	report('booted');
}

if (parentPort) runWorkerFixture();
