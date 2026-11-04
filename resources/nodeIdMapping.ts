/**
 * This module is responsible for managing the mapping of node/host names to node ids.
 */
import { logger } from '../utility/logging/logger.ts';
import { getThisNodeName } from '../server/nodeName.ts';
import { pack, unpack } from 'msgpackr';
import type { Database } from 'lmdb';
import { server } from '../server/Server.ts';
import { commitAuditMetadata } from './auditStore.ts';

const REMOTE_NODE_IDS = Symbol.for('remote-ids');
function getIdMappingRecord(auditStore) {
	const stored = auditStore.getBinary(REMOTE_NODE_IDS);
	const idMappingRecord = (stored ? unpack(stored) : null) ?? { remoteNameToId: {} };
	// this is the default mapping for the local node (id of 0 is used for local)
	idMappingRecord.nodeName = getThisNodeName();
	if (idMappingRecord.remoteNameToId[idMappingRecord.nodeName] === 0) return idMappingRecord;
	// Take over the local id inside the mapping transaction: a plain write here would erase another worker's
	// mint. A previous host name holding id 0 moves to a new id, whose sequence cursor starts from our last one.
	let reassignedId: number | undefined;
	idMappingRecord.remoteNameToId = updateIdMapping(auditStore, (nameToId) => {
		const nodeName = getThisNodeName();
		reassignedId = undefined;
		if (nameToId[nodeName] === 0) return false;
		for (const name in nameToId) {
			if (nameToId[name] === 0) {
				reassignedId = nextNodeId(nameToId);
				nameToId[name] = reassignedId;
			}
		}
		nameToId[nodeName] = 0;
		return true;
	});
	if (reassignedId !== undefined) {
		const seqKey = [Symbol.for('seq'), reassignedId];
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
	return idMappingRecord;
}
export function exportIdMapping(auditStore) {
	return getIdMappingRecord(auditStore).remoteNameToId;
}

function nextNodeId(nameToId: Record<string, number>): number {
	let lastId = 0;
	for (const name in nameToId) {
		const id = nameToId[name];
		if (id > lastId) lastId = id;
	}
	return lastId + 1;
}

/**
 * One read-modify-write of the mapping under a store transaction, so two workers minting at once cannot
 * hand one id to two names or drop each other's additions. Returns the mapping as committed.
 */
function updateIdMapping(auditStore: any, mutate: (nameToId: Record<string, number>) => boolean) {
	let record: any;
	commitAuditMetadata(
		auditStore,
		(read) => {
			const stored = read(REMOTE_NODE_IDS);
			record = (stored ? unpack(stored) : null) ?? { remoteNameToId: {} };
			record.nodeName = getThisNodeName();
			return mutate(record.remoteNameToId) ? [[REMOTE_NODE_IDS, pack(record)]] : undefined;
		},
		'node id mapping'
	);
	// another worker may have made this change first, leaving this thread's cached names stale either way
	invalidateNodeNames(auditStore);
	return record.remoteNameToId as Record<string, number>;
}

function hasUnmappedName(remoteMapping: Record<string, number>, nameToId: Record<string, number>): boolean {
	for (const name in remoteMapping) if (nameToId[name] == undefined) return true;
	return false;
}

/**
 * Take the remote node's long id to short id mapping and create a map from the remote node's short id to the local node short id.
 */
export function remoteToLocalNodeId(remoteMapping: any, auditStore: any) {
	let nameToId = getIdMappingRecord(auditStore).remoteNameToId;
	if (hasUnmappedName(remoteMapping, nameToId)) {
		nameToId = updateIdMapping(auditStore, (stored) => {
			let nextId = nextNodeId(stored);
			let changed = false;
			for (const remoteNodeName in remoteMapping) {
				if (stored[remoteNodeName] != undefined) continue;
				stored[remoteNodeName] = nextId++;
				changed = true;
			}
			return changed;
		});
	}
	const remoteToLocalId = new Map();
	for (const remoteNodeName in remoteMapping)
		remoteToLocalId.set(remoteMapping[remoteNodeName], nameToId[remoteNodeName]);
	return remoteToLocalId;
}

export function getIdOfRemoteNode(remoteNodeName, auditStore) {
	let nameToId = getIdMappingRecord(auditStore).remoteNameToId;
	if (nameToId[remoteNodeName] == undefined) {
		nameToId = updateIdMapping(auditStore, (stored) => {
			if (stored[remoteNodeName] != undefined) return false;
			stored[remoteNodeName] = nextNodeId(stored);
			return true;
		});
	}
	const id = nameToId[remoteNodeName];
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
// misses re-read at most this often — short enough that a joining node loses at most a stray entry,
// long enough that a burst of unmapped ids cannot drive the store. `onMiss` records whether the
// cached map was built by a `rebuildOnMiss` caller, which is what bounds that caller to one read per
// window too rather than exempting it from the interval entirely.
const NODE_NAME_REFRESH_MS = 50;
const idToNodeName = new WeakMap<object, { names: Map<number, string>; refreshedAt: number; onMiss: boolean }>();
function invalidateNodeNames(auditStore: any) {
	idToNodeName.delete(auditStore);
}

/**
 * The node name a local short id refers to. Callers that must attribute a replicated entry to its
 * origin node need the globally stable name, not the id, which is assigned per node.
 */
export function getNodeNameForId(
	auditStore: any,
	nodeId: number | undefined,
	rebuildOnMiss = false
): string | undefined {
	if (typeof nodeId !== 'number' || !auditStore) return undefined;
	const cached = idToNodeName.get(auditStore);
	const hit = cached?.names.get(nodeId);
	if (hit !== undefined) return hit;
	const now = Date.now();
	// `rebuildOnMiss` is for entry classes whose loss costs more than the read: a dropped record lock
	// release leaves the home holding a grant until its own deadline, so a just-minted id is worth one
	// store read rather than up to `NODE_NAME_REFRESH_MS` of dropped entries. ONE read, though, not one
	// per entry — an id this map will never resolve (a node whose mapping was purged, an origin
	// relayed from a database that never minted one) is exactly the burst the interval exists to keep
	// off the apply thread, and a rebuild inside the window is not stale: a write to the mapping drops
	// this entry outright (`invalidateNodeNames`).
	if (cached && now - cached.refreshedAt < NODE_NAME_REFRESH_MS && (!rebuildOnMiss || cached.onMiss)) return undefined;
	const nameToId = exportIdMapping(auditStore);
	const names = new Map<number, string>();
	for (const name in nameToId) names.set(nameToId[name], name);
	idToNodeName.set(auditStore, { names, refreshedAt: now, onMiss: rebuildOnMiss });
	return names.get(nodeId);
}
