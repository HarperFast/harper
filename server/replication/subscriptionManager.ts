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
export let disconnectedFromNode;
export function startOnMainThread(options) {
	let new_node_listeners = [];
	let all_nodes: any[];
	let node_replication_map = new Map();
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
			return;
		const databases = getDatabases();
		let db_replication_workers = node_replication_map.get(node.url);
		if (!db_replication_workers) {
			db_replication_workers = new Map();
			node_replication_map.set(node.url, db_replication_workers);
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
			if (worker) {
				db_replication_workers.set(database_name, {
					worker,
					nodes,
				});
				worker.postMessage({
					type: 'subscribe-to-node',
					database: database_name,
					nodes,
				});
			} else subscribeToNode({ database: database_name, nodes });
		}
	}
	onMessageByType(
		'disconnected-from-node',
		(disconnectedFromNode = (message) => {
			// if a node is disconnected, we need to reassign the subscriptions to another node
			const sorted_urls = Array.from(node_replication_map.keys()).sort();
			const index = sorted_urls.indexOf(message.url);
			const next_index = (index + 1) % sorted_urls.length;
			const next_url = sorted_urls[next_index];
			const db_replication_workers = node_replication_map.get(next_url);
			if (!db_replication_workers) return;
			for (const [database_name, worker_entry] of db_replication_workers) {
				worker_entry.additionalNodes.push(message.url);
				worker_entry.worker.postMessage({
					type: 'subscribe-to-node',
					database: database_name,
					url: message.url,
					additionalNodes: worker_entry.additionalNodes,
				});
			}
		})
	);
	onMessageByType('reconnected-to-node', (message) => {});
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
