import { hostname } from 'os';
import env from '../../utility/environment/environmentManager';
import { pack, unpack } from 'msgpackr';

function getIdMappingRecord(audit_store) {
	let id_mapping_record = audit_store.idMapping;
	if (!id_mapping_record) {
		const id_mapping_record_buffer = audit_store.get(Symbol.for('remote-ids'));
		audit_store.idMapping = id_mapping_record = id_mapping_record_buffer ? unpack(id_mapping_record_buffer) : null;
	}
	if (!id_mapping_record) {
		id_mapping_record = {
			nodeName: (env.get('clustering_nodename') || hostname()) + '-' + Math.random().toString(36).substring(2, 6),
			remoteNameToId: {},
		};
		audit_store.putSync(Symbol.for('remote-ids'), pack(id_mapping_record));
	}
	console.log('id_mapping_record', audit_store.path, id_mapping_record.nodeName);
	return id_mapping_record;
}
export function getNodeName(audit_store) {
	return getIdMappingRecord(audit_store).nodeName;
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
	remote_mapping[remote_node_name] = 0; // Self-originating writes are always 0
	for (const remote_node_name in remote_mapping) {
		const remote_id = remote_mapping[remote_node_name];
		let local_id = name_to_id[remote_node_name];
		if (!local_id) {
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
		audit_store.putSync(Symbol.for('remote-ids'), pack(id_mapping_record));
	}
	return remote_to_local_id;
}
