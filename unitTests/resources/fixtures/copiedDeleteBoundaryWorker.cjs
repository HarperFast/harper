require('../../testUtils');
const { parentPort, workerData } = require('node:worker_threads');
const { setupTestDBPath } = require('../../testUtils');
const { resetDatabases } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { Resource } = require('#src/resources/Resource');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { onMessageByType } = require('#src/server/threads/manageThreads');

const { database } = workerData;
const CONTROL = 'copied-delete-boundary-control';
const REPLY = 'copied-delete-boundary-reply';
let Records;
// strong references to the cached values: the record cache holds them weakly, and a collected one is a cache miss
const held = new Map();

setupTestDBPath();
onMessageByType(CONTROL, () => {});

const summary = (entry) =>
	entry && {
		version: entry.version,
		flags: entry.metadataFlags,
		value: entry.value && { ...entry.value },
		boundary: entry.copiedDeleteBoundary,
	};

async function handle({ command, table, key, record, version, nodeName }) {
	switch (command) {
		case 'init':
			Records = resetDatabases()[database][table];
			held.clear();
			if (record)
				Records.sourcedFrom(
					class extends Resource {
						static get(id) {
							return { ...record, id };
						}
					}
				);
			return {};
		case 'cache': {
			Records.primaryStore.getEntry(key);
			const entry = Records.primaryStore.getEntry(key);
			held.set(key, entry.value);
			return summary(entry);
		}
		case 'peek':
			return summary(Records.primaryStore.getEntry(key));
		case 'copy-put': {
			// the options replication's writeUpdate (Table.ts sourcedFrom) passes for a base-copy frame
			const options = {
				isNotification: true,
				ensureLoaded: false,
				nodeId: getIdOfRemoteNode(nodeName, Records.auditStore),
				version,
				isCopyApply: true,
				async: true,
			};
			const context = { source: {}, sourceApply: true, timestamp: version };
			await transaction(context, async () => {
				const resource = await Records.getResource(key, context, options);
				return resource._writeUpdate(key, record, true, options);
			});
			return {};
		}
		case 'source-get':
			return { ...(await Records.get(key)) };
		case 'evict': {
			const entry = Records.primaryStore.getEntry(key);
			await Records.evict(key, entry.value, entry.version);
			return {};
		}
		case 'store-replica': {
			const entry = Records.primaryStore.getEntry(key);
			return {
				stored: await Records._storeReplica(entry, {
					key,
					value: { ...entry.value, ...record },
					version: entry.version,
					originNode: nodeName,
					fullWriteHead: entry.version,
				}),
			};
		}
		default:
			throw new Error(`Unknown fixture command ${command}`);
	}
}

parentPort.on('message', async (message) => {
	if (message.type !== CONTROL) return;
	try {
		parentPort.postMessage({ type: REPLY, id: message.id, result: await handle(message) });
	} catch (error) {
		parentPort.postMessage({ type: REPLY, id: message.id, error: error.stack });
	}
});
parentPort.ref();
