/**
 * This module is responsible for managing the subscriptions for replication. It determines the connections and
 * subscriptions that are needed and delegates them to the available threads. It also manages when connections are
 * lost and delegating subscriptions through other nodes
 */
import { getDatabases, onUpdatedTable, table } from '../../resources/databases';
import { workers, onMessageByType } from '../threads/manageThreads';
import { table_update_listeners } from './replicationConnection';
import { getThisNodeName, getThisNodeUrl, subscribeToNode } from './replicator';
import { parentPort } from 'worker_threads';

let hdb_node_table;
let connection_replication_map = new Map();
let node_map = new Map();
export function startOnMainThread(options) {
	let new_node_listeners = [];
	let all_nodes: any[];
	let next_worker_index = 0;
	route_loop: for (const route of options.routes || []) {
		try {
			let url = typeof route === 'string' ? route : route.url;
			if (!url) {
				if (route.host) url = 'wss://' + route.host + ':' + (route.port || 9925);
				else {
					console.error('Invalid route, must specify a url or host (with port)');
					continue;
				}
			}
			ensureNode(route.name ?? url, url);
		} catch (error) {
			console.error(error);
		}
	}

	getHDBNodeTable()
		.subscribe({})
		.then(async (events) => {
			for await (let event of events) {
				if (event.type === 'put') {
					onNewNode(event.value);
				}
			}
		});
	function onNewNode(node) {
		if ((getThisNodeName() && node.name === getThisNodeName()) || (getThisNodeUrl() && node.name === getThisNodeUrl()))
			// this is just this node, we don't need to connect to ourselves
			return;
		node_map.set(node.name, node);
		const databases = getDatabases();
		let db_replication_workers = connection_replication_map.get(node.url);
		if (!db_replication_workers) {
			db_replication_workers = new Map();
			connection_replication_map.set(node.url, db_replication_workers);
		}
		const enabled_databases = options?.databases ?? databases;
		for (const database_name in enabled_databases) {
			let database = enabled_databases[database_name];
			if (!database) continue;
			database = typeof database === 'object' ? database : databases[database_name];
			for (const table_name in database) {
				const Table = database[table_name];
				onDatabase(database_name, Table);
			}
		}
		onUpdatedTable((Table, is_changed) => {
			if (is_changed) {
			} else onDatabase(Table.databaseName, Table);
		});

		function onDatabase(database_name) {
			let worker = workers[next_worker_index];
			next_worker_index = (next_worker_index + 1) % workers.length;
			let nodes = [node];
			db_replication_workers.set(database_name, {
				worker,
				nodes,
			});
			if (worker) {
				worker.postMessage({
					type: 'subscribe-to-node',
					database: database_name,
					nodes,
				});
			} else subscribeToNode({ database: database_name, nodes });
		}
	}
	onMessageByType('disconnected-from-node', disconnectedFromNode);
	onMessageByType('reconnected-to-node', (message) => {});
}

export function disconnectedFromNode(connection) {
	// if a node is disconnected, we need to reassign the subscriptions to another node
	const node_names = Array.from(node_map.keys()).sort();
	const index = node_names.indexOf(connection.name);
	let next_index = index;
	do {
		next_index = (next_index + 1) % node_names.length;
		const next_node_name = node_names[next_index];
		const next_node = node_map.get(next_node_name);
		const db_replication_workers = connection_replication_map.get(next_node.url);
		const worker_entry = db_replication_workers?.get(connection.database);
		if (!worker_entry) continue;
		const { worker, nodes } = worker_entry;
		nodes.push(connection);
		if (worker) {
			worker.postMessage({
				type: 'subscribe-to-node',
				database: connection.database,
				nodes,
			});
		} else subscribeToNode({ database: connection.database, nodes });
		return;
	} while (index !== next_index);
}

if (parentPort) {
	disconnectedFromNode = (connection) => {
		parentPort.postMessage('disconnected-from-node', connection);
	};
	onMessageByType('subscribe-to-node', (message) => {
		subscribeToNode(message);
	});
}

export function ensureNode(name: string, url: string, routes = []) {
	const table = getHDBNodeTable();
	const isTentative = !name;
	name = name ?? url;
	if (table.primaryStore.get(name)?.url !== url) {
		table.put({ name, url, routes, isTentative });
	}
}
function getHDBNodeTable() {
	return (
		hdb_node_table ||
		(hdb_node_table = table({
			table: 'hdb_node_table',
			database: 'system',
			audit: true,
			attributes: [
				{
					name: 'name',
					isPrimaryKey: true,
				},
				{
					name: 'url',
				},
				{
					name: 'routes',
				},
			],
		}))
	);
}
