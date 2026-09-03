/**
 * This module is responsible for managing the mapping of node/host names to node ids.
 */
import { logger } from '../utility/logging/logger.ts';
import { getThisNodeName } from '../server/nodeName.ts';
import { pack, unpack } from 'msgpackr';
import type { Database } from 'lmdb';
import { server } from '../server/Server.ts';

const REMOTE_NODE_IDS = Symbol.for('remote-ids');
function getIdMappingRecord(auditStore) {
	const idMappingRecordBuffer = auditStore.getBinary(REMOTE_NODE_IDS);
	let idMappingRecord = idMappingRecordBuffer ? unpack(idMappingRecordBuffer) : null;
	if (!idMappingRecord) {
		idMappingRecord = { remoteNameToId: {} };
	}
	// this is the default mapping for the local node (id of 0 is used for local)
	const node_name = getThisNodeName();
	idMappingRecord.nodeName = getThisNodeName();
	const nameToId = idMappingRecord.remoteNameToId;
	if (nameToId[node_name] !== 0) {
		// if we don't have the local node id, we want to assign it and take over that id, but if there was a previous host name
		// there, we need to reassign it and update the record and we want to assign a starting sequence id for it
		let lastId = 0;
		let previousLocalHostName: string;
		for (const name in nameToId) {
			const id = nameToId[name];
			if (id === 0) {
				previousLocalHostName = name;
			} else if (id > lastId) {
				lastId = id;
			}
		}
		if (previousLocalHostName) {
			// we need to reassign the local node id to the previous host name
			lastId++;
			nameToId[previousLocalHostName] = lastId;
			// we need to update the sequence id for the previous host name, and have it start from our last sequence id
			const seqKey = [Symbol.for('seq'), lastId];
			auditStore.rootStore.dbisDb.transactionSync(() => {
				// getSync (not get): a get() Promise on a RocksDB cache miss is truthy, so `!...get(seqKey)`
				// would be false and skip initializing the seq record for the reassigned node id.
				if (!(auditStore.rootStore.dbisDb as any).getSync(seqKey))
					auditStore.rootStore.dbisDb.putSync(seqKey, {
						seqId: lastTimeInAuditStore(auditStore) ?? 1,
						nodes: [],
					});
			});
		}
		// now we can take over the local node id
		nameToId[node_name] = 0;
		auditStore.putSync(REMOTE_NODE_IDS, pack(idMappingRecord));
		invalidateNodeNames(auditStore);
	}
	return idMappingRecord;
}
export function exportIdMapping(auditStore) {
	return getIdMappingRecord(auditStore).remoteNameToId;
}

/**
 * Take the remote node's long id to short id mapping and create a map from the remote node's short id to the local node short id.
 */
export function remoteToLocalNodeId(remoteMapping: any, auditStore: any) {
	const idMappingRecord = getIdMappingRecord(auditStore);
	const nameToId = idMappingRecord.remoteNameToId;
	const remoteToLocalId = new Map();
	let hasChanges = false;
	for (const remoteNodeName in remoteMapping) {
		const remoteId = remoteMapping[remoteNodeName];
		let localId = nameToId[remoteNodeName];
		if (localId == undefined) {
			let lastId = 0;
			for (const name in nameToId) {
				const id = nameToId[name];
				if (id > lastId) {
					lastId = id;
				}
			}
			localId = lastId + 1;
			nameToId[remoteNodeName] = localId;
			hasChanges = true;
		}
		remoteToLocalId.set(remoteId, localId);
	}
	if (hasChanges) {
		auditStore.putSync(REMOTE_NODE_IDS, pack(idMappingRecord));
		invalidateNodeNames(auditStore);
	}
	return remoteToLocalId;
}

export function getIdOfRemoteNode(remoteNodeName, auditStore) {
	const idMappingRecord = getIdMappingRecord(auditStore);
	const nameToId = idMappingRecord.remoteNameToId;
	let id = nameToId[remoteNodeName];
	if (id == undefined) {
		let lastId = 0;
		for (const name in nameToId) {
			const id = nameToId[name];
			if (id > lastId) {
				lastId = id;
			}
		}
		id = lastId + 1;
		nameToId[remoteNodeName] = id;
		auditStore.putSync(REMOTE_NODE_IDS, pack(idMappingRecord));
		invalidateNodeNames(auditStore);
	}
	logger.trace?.('The remote node name map', remoteNodeName, nameToId, id);
	return id;
}

/**
 * Get the last time that an audit record was added to the audit store
 * @param auditStore
 */
export function lastTimeInAuditStore(auditStore: Database) {
	for (const timestamp of auditStore.getKeys({
		limit: 1,
		reverse: true,
	})) {
		return timestamp;
	}
}
export function getThisNodeId(auditStore: any) {
	return exportIdMapping(auditStore)?.[server.hostname];
}

// Inverted id -> name map. exportIdMapping() re-reads and unpacks the mapping record on every call,
// which is far too much per replicated entry on the apply thread; ids are stable once minted, so the
// inversion is cached and dropped wherever nameToId is written. Keyed per audit store because short
// ids are minted per database in first-seen order — id 1 names a different node in each one.
// Refresh window for a MISS. A hit is always trusted, but a miss cannot be: ids are minted by
// whichever worker first talks to a peer, and invalidation only reaches that worker's own copy — so
// a newly admitted node is absent from every other worker's map until it is rebuilt. Rebuilding on
// every miss would put a store read and unpack back on the apply thread for each unmapped entry, so
// misses re-read at most once a second.
const NODE_NAME_REFRESH_MS = 1000;
const idToNodeName = new WeakMap<object, { names: Map<number, string>; refreshedAt: number }>();
function invalidateNodeNames(auditStore: any) {
	idToNodeName.delete(auditStore);
}

/**
 * The node name a local short id refers to. Callers that must attribute a replicated entry to its
 * origin node need the globally stable name, not the id, which is assigned per node.
 */
export function getNodeNameForId(auditStore: any, nodeId: number | undefined): string | undefined {
	if (typeof nodeId !== 'number' || !auditStore) return undefined;
	const cached = idToNodeName.get(auditStore);
	const hit = cached?.names.get(nodeId);
	if (hit !== undefined) return hit;
	const now = Date.now();
	if (cached && now - cached.refreshedAt < NODE_NAME_REFRESH_MS) return undefined;
	const nameToId = exportIdMapping(auditStore);
	const names = new Map<number, string>();
	for (const name in nameToId) names.set(nameToId[name], name);
	idToNodeName.set(auditStore, { names, refreshedAt: now });
	return names.get(nodeId);
}
