/**
 * This module is responsible for managing the mapping of node names to node ids.
 */
import * as logger from '../../utility/logging/logger';
import { getThisNodeName } from './replicator';
import { pack, unpack } from 'msgpackr';

const REMOTE_NODE_IDS = Symbol.for('remote-ids');
function getIdMappingRecord(audit_store) {
	const id_mapping_record_buffer = audit_store.get(REMOTE_NODE_IDS);
	let id_mapping_record = id_mapping_record_buffer ? unpack(id_mapping_record_buffer) : null;
	if (!id_mapping_record) {
		id_mapping_record = { remoteNameToId: {} };
	}
	// this is the default mapping for the local node (id of 0 is used for local)
	// TODO: We should add an option so the if the node name is changed, which should take place in a clone node operation, we will get a new node name and node id)
	const node_name = getThisNodeName();
	const has_changes = false;
	id_mapping_record.nodeName = getThisNodeName();
	if (id_mapping_record.remoteNameToId[node_name] !== 0) {
		id_mapping_record.remoteNameToId[node_name] = 0;
		audit_store.putSync(REMOTE_NODE_IDS, pack(id_mapping_record));
	}
	return id_mapping_record;
}
export function exportIdMapping(audit_store) {
	return getIdMappingRecord(audit_store).remoteNameToId;
}

/**
 * Take the remote node's long id to short id mapping and create a map from the remote node's short id to the local node short id.
 */
export function remoteToLocalNodeId(remote_node_name, remote_mapping, audit_store) {
	const id_mapping_record = getIdMappingRecord(audit_store);
	const name_to_id = id_mapping_record.remoteNameToId;
	const remote_to_local_id = new Map();
	let has_changes = false;
	for (const remote_node_name in remote_mapping) {
		const remote_id = remote_mapping[remote_node_name];
		let local_id = name_to_id[remote_node_name];
		if (local_id == undefined) {
			let last_id = 0;
			for (const name in name_to_id) {
				const id = name_to_id[name];
				if (id > last_id) {
					last_id = id;
				}
			}
			local_id = last_id + 1;
			name_to_id[remote_node_name] = local_id;
			has_changes = true;
		}
		remote_to_local_id.set(remote_id, local_id);
	}
	if (has_changes) {
		audit_store.putSync(REMOTE_NODE_IDS, pack(id_mapping_record));
	}
	return remote_to_local_id;
}

export function getIdOfRemoteNode(remote_node_name, audit_store) {
	const id_mapping_record = getIdMappingRecord(audit_store);
	const name_to_id = id_mapping_record.remoteNameToId;
	let id = name_to_id[remote_node_name];
	if (id == undefined) {
		let last_id = 0;
		for (const name in name_to_id) {
			const id = name_to_id[name];
			if (id > last_id) {
				last_id = id;
			}
		}
		id = last_id + 1;
		name_to_id[remote_node_name] = id;
		audit_store.putSync(REMOTE_NODE_IDS, pack(id_mapping_record));
	}
	logger.info?.('The remote node name map', remote_node_name, name_to_id, id);
	return id;
}
