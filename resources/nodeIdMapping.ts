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
