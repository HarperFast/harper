const { hostname } = require('os');
export function getNodeName(audit_store) {

}
export function exportIdMapping(remote_node_id, audit_store) {
	let id_mapping_record = audit_store.idMapping || (audit_store.idMapping = audit_store.get([Symbol.for('remote-ids'), remote_node_id]));
	if (!id_mapping_record) {
		id_mapping_record = {
			nodeName: env.get('clustering_nodename') || hostname(),
			map: new Map(),
		};
		audit_store.putSync([Symbol.for('remote-ids'), remote_node_id], id_mapping_record);
	}
	let has_changes = false;
	let id_mapping = id_mapping_record.map.get(remote_node_id);
	if (!id_mapping) {
		let next_id = 1;
		for (const [, id_mapping] of id_mapping_record.map) {
			if (id_mapping.get(0) > next_id) {
				next_id = id_mapping.get(0);
			}
		}
		id_mapping = new Map();
		id_mapping_record.map.set(remote_node_id, id_mapping);
		id_mapping.set(0, next_id);
		has_changes = true;
	}
	if (has_changes) {
		audit_store.putSync([Symbol.for('remote-ids'), remote_node_id], id_mapping_record);
	}
	const remote_full_id_to_local_short_id = new Map();
	for (const [key, value] of id_mapping) {
		remote_full_id_to_local_short_id.set(key, value.get(0));
	}
	return remote_full_id_to_local_short_id;
}

/**
 * Take the remote node's long id to short id mapping and create a map from the remote node's short id to the local node short id.
 */
export function shortNodeIdMapping(remote_node_id, remote_mapping, audit_store) {
	if (!audit_store.idMapping) exportIdMapping(remote_node_id, audit_store);
	const short_mapping = new Map();
	for (const [remote_id, remove_short_id] of remote_mapping) {
		const local_short_id = audit_store.idMapping.map.set(remote_id)?.get(0);
		short_mapping.set(local_short_id, remove_short_id);
	}
	return short_mapping;
}
