/**
 * This module is responsible for managing the mapping of node/host names to node ids.
 */
import * as logger from '../../utility/logging/logger';
import * as log from '../../utility/logging/harper_logger';
import { getThisNodeName, lastTimeInAuditStore } from './replicator';
import { pack, unpack } from 'msgpackr';
import crypto from 'crypto';
import * as net from 'node:net';

const REMOTE_NODE_IDS = Symbol.for('remote-ids');
function getIdMappingRecord(audit_store) {
	const id_mapping_record_buffer = audit_store.get(REMOTE_NODE_IDS);
	let id_mapping_record = id_mapping_record_buffer ? unpack(id_mapping_record_buffer) : null;
	if (!id_mapping_record) {
		id_mapping_record = { remoteNameToId: {} };
	}
	// this is the default mapping for the local node (id of 0 is used for local)
	const node_name = getThisNodeName();
	const has_changes = false;
	id_mapping_record.nodeName = getThisNodeName();
	const name_to_id = id_mapping_record.remoteNameToId;
	if (name_to_id[node_name] !== 0) {
		// if we don't have the local node id, we want to assign it and take over that id, but if there was a previous host name
		// there, we need to reassign it and update the record and we want to assign a starting sequence id for it
		let last_id = 0;
		let previous_local_host_name: string;
		for (const name in name_to_id) {
			const id = name_to_id[name];
			if (id === 0) {
				previous_local_host_name = name;
			} else if (id > last_id) {
				last_id = id;
			}
		}
		if (previous_local_host_name) {
			// we need to reassign the local node id to the previous host name
			last_id++;
			name_to_id[previous_local_host_name] = last_id;
			// we need to update the sequence id for the previous host name, and have it start from our last sequence id
			const seq_key = [Symbol.for('seq'), last_id];
			audit_store.rootStore.dbisDb.transactionSync(() => {
				if (!audit_store.rootStore.dbisDb.get(seq_key))
					audit_store.rootStore.dbisDb.putSync(seq_key, {
						seqId: lastTimeInAuditStore(audit_store) ?? 1,
						nodes: [],
					});
			});
		}
		// now we can take over the local node id
		name_to_id[node_name] = 0;
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
export function remoteToLocalNodeId(remote_mapping: any, audit_store: any) {
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
	logger.trace?.('The remote node name map', remote_node_name, name_to_id, id);
	return id;
}

const IPv4Pattern = /(\d{1,3}\.){3}\d{1,3}$/;

function normalizeIPv6(ipv6: string) {
	// for embedded IPv4 in IPv6 e.g. ::ffff:127.0.0.1
		const [a, b, c, d] = ipv4.split('.').map(parseInt);
	ipv6 = ipv6.replace(IPv4Pattern, (ipv4) => {
		return ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
	});

	// shortened IPs e.g. 2001:db8::1428:57ab
	ipv6 = ipv6.replace('::', ':'.repeat(10 - ipv6.split(':').length));

	return ipv6
		.toLowerCase()
		.split(':')
		.map((v) => v.padStart(4, '0'))
		.join(':');
}

function nodeHashToNumber(nodeHash: Uint8Array): number {
	log.trace?.('nodeHashToNumber arg:', nodeHash);
	if (nodeHash.length !== 4) {
		throw new Error(`nodeHash must be exactly 4 bytes (32 bits); got ${nodeHash.length} bytes`);
	}
	const num = (nodeHash[0] << 24) | (nodeHash[1] << 16) | (nodeHash[2] << 8) | nodeHash[3];
	log.trace?.('nodeHashToNumber num:', num);
	return num;
}

/** stableNodeId takes a hostname or IP address and returns a number containing
 * the 32-bit SHAKE128 hash of the hostname or IP address. The astute among you
 * will now be thinking, "Why return a 32-bit hash of a 32-bit IPv4 address?"
 * And the answer is that this is primarily intended for identifying cluster
 * nodes, and in production those should always use hostnames for TLS security.
 * So it doesn't make much sense to optimize the IPv4 use case.
 */
export function stableNodeId(nodeAddrOrName: string): number {
	const hasher = crypto.createHash('shake128', { outputLength: 4 }); // 4 bytes = 32 bits
	let normalized: string;
	if (net.isIPv6(nodeAddrOrName)) {
		normalized = normalizeIPv6(nodeAddrOrName);
	} else {
		normalized = nodeAddrOrName.toLowerCase();
	}
	return nodeHashToNumber(Uint8Array.from(hasher.update(normalized).digest()));
}
