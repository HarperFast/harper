/**
 * This module is responsible for managing the subscriptions for replication. It determines the connections and
 * subscriptions that are needed and delegates them to the available threads. It also manages when connections are
 * lost and delegating subscriptions through other nodes
 */
import { getDatabases, onUpdatedTable, table } from '../../resources/databases';
import { workers, onMessageByType, whenThreadsStarted } from '../threads/manageThreads';
import { table_update_listeners } from './replicationConnection';
import {
	getThisNodeName,
	getThisNodeUrl,
	subscribeToNode,
	urlToNodeName,
	forEachReplicatedDatabase,
	unsubscribeFromNode,
} from './replicator';
import { parentPort } from 'worker_threads';
import { subscribeToNodeUpdates, getHDBNodeTable, iterateRoutes, shouldReplicateToNode } from './knownNodes';
import * as logger from '../../utility/logging/harper_logger';
import { cloneDeep } from 'lodash';

const NODE_SUBSCRIBE_DELAY = 200; // delay before sending node subscribe to other nodes, so operations can complete first
const connection_replication_map = new Map();
export let disconnectedFromNode; // this is set by thread to handle when a node is disconnected (or notify main thread so it can handle)
export let connectedToNode; // this is set by thread to handle when a node is connected (or notify main thread so it can handle)
const node_map = new Map(); // this is a map of all nodes that are available to connect to
export async function startOnMainThread(options) {
	// we do all of the main management of tracking connections and subscriptions on the main thread and delegate
	// the actual work to the worker threads
	const new_node_listeners = [];
	let all_nodes: any[];
	let next_worker_index = 0;

	// we need to wait for the threads to start before we can start adding nodes
	// but don't await this because this start function has to finish before the threads can start
	whenThreadsStarted.then(async () => {
		const nodes = [];
		for await (const node of getDatabases().system.hdb_nodes.search([])) {
			nodes.push(node);
		}
		for (const route of iterateRoutes(options)) {
			try {
				const replicate_all = !route.subscriptions;
				if (replicate_all) {
					const this_name = getThisNodeName();
					// If it doesn't exist and hasn't been created. Note that this will be null if it has previously been deleted,
					// and we don't want to recreate nodes for deleted nodes
					if (getHDBNodeTable().primaryStore.get(this_name) === undefined)
						await ensureNode(this_name, {
							name: this_name,
							url: options.url ?? getThisNodeUrl(),
							replicates: true,
						});
				}
				const replicate_system = route.trusted !== false;
				if (replicate_all) {
					if (route.replicates == undefined) route.replicates = true;
				}
				if (nodes.find((node) => node.url === route.url)) continue;
				// just tentatively add this node to the list of nodes in memory
				onNodeUpdate(route);
			} catch (error) {
				console.error(error);
			}
		}
		subscribeToNodeUpdates(onNodeUpdate);
	});
	let is_fully_replicating;
	/**
	 * This is called when a new node is added to the hdb_nodes table
	 * @param node
	 */
	function onNodeUpdate(node, hostname = node?.name) {
		const is_self =
			(getThisNodeName() && hostname === getThisNodeName()) || (getThisNodeUrl() && node?.url === getThisNodeUrl());
		if (is_self) {
			// this is just this node, we don't need to connect to ourselves, but if we get removed, we need to remove all fully replicating connections,
			// so we update each one
			const should_fully_replicate = Boolean(node?.replicates);
			if (is_fully_replicating !== undefined && is_fully_replicating !== should_fully_replicate) {
				for (const node of getHDBNodeTable().search([])) {
					if (node.replicates && node.name !== hostname) onNodeUpdate(node, node.name);
				}
			}
			is_fully_replicating = should_fully_replicate;
		}
		logger.trace('Setting up node replication for', node);
		if (!node) {
			// deleted node
			for (const [url, db_replication_workers] of connection_replication_map) {
				let found_node;
				for (const [database, { worker, nodes }] of db_replication_workers) {
					const node = nodes[0];
					if (!node) continue;
					if (node.name == hostname) {
						found_node = true;
						for (const [database, { worker }] of db_replication_workers) {
							db_replication_workers.delete(database);
							worker?.postMessage({ type: 'unsubscribe-from-node', node: hostname, database, url });
						}
						break;
					}
				}
				if (found_node) {
					const db_replication_workers = connection_replication_map.get(url);
					db_replication_workers.iterator.remove();
					connection_replication_map.delete(url);
					return;
				}
			}
			return;
		}
		if (is_self) return;
		if (!node.url) {
			logger.info(`Node ${node.name} is missing url`);
			return;
		}
		let db_replication_workers = connection_replication_map.get(node.url);
		if (db_replication_workers) db_replication_workers.iterator.remove(); // we need to remove the old iterator so we can create a new one
		if (!(node.replicates === true || node.replicates?.sends) && !node.subscriptions?.length && !db_replication_workers)
			return; // we don't have any subscriptions and we haven't connected yet, so just return
		logger.info(`Added node ${node.name} at ${node.url} for process ${getThisNodeName()}`);
		if (node.name) {
			// don't add to a map if we don't have a name (yet)
			// replace any node with same url
			for (const [key, existing_node] of node_map) {
				if (node.url === existing_node.url) {
					node_map.delete(key);
					break;
				}
			}
			node_map.set(node.name, node);
		}
		const databases = getDatabases();
		if (!db_replication_workers) {
			db_replication_workers = new Map();
			connection_replication_map.set(node.url, db_replication_workers);
		}
		db_replication_workers.iterator = forEachReplicatedDatabase(
			options,
			(database, database_name, replicate_by_default) => {
				if (replicate_by_default) {
					onDatabase(database_name, true);
				} else {
					onDatabase(database_name, false);
				}
			}
		);
		// check to see if there are any explicit subscriptions to databases that don't exist yet
		if (node.subscriptions) {
			// if we can't find any more granular subscriptions, then we skip this database
			// check to see if we have any explicit node subscriptions
			for (const sub of node.subscriptions) {
				const database_name = sub.database || sub.schema;
				if (!databases[database_name]) {
					logger.warn(`Database ${database_name} not found for node ${node.name}, making a subscription anyway`);
					onDatabase(database_name, false);
				}
			}
		}

		function onDatabase(database_name, tables_replicate_by_default) {
			logger.trace('Setting up replication for database', database_name, 'on node', node.name);
			const existing_entry = db_replication_workers.get(database_name);
			let worker;
			const nodes = [{ replicateByDefault: tables_replicate_by_default, ...node }];
			const should_subscribe = shouldReplicateToNode(node, database_name);
			const http_workers = workers.filter((worker) => worker.name === 'http');
			if (existing_entry) {
				worker = existing_entry.worker;
				existing_entry.nodes = nodes;
			} else if (should_subscribe) {
				next_worker_index = next_worker_index % http_workers.length; // wrap around as necessary
				worker = http_workers[next_worker_index++];

				db_replication_workers.set(database_name, {
					worker,
					nodes,
					url: node.url,
				});
				worker?.on('exit', () => {
					// when a worker exits, we need to remove the entry from the map, and then reassign the subscriptions
					if (db_replication_workers.get(database_name)?.worker === worker) {
						// first verify it is still the worker
						db_replication_workers.delete(database_name);
						onDatabase(database_name, tables_replicate_by_default);
					}
				});
			}
			if (should_subscribe) {
				setTimeout(() => {
					const request = {
						type: 'subscribe-to-node',
						database: database_name,
						nodes,
					};
					if (worker) {
						worker.postMessage(request);
					} else subscribeToNode(request);
				}, NODE_SUBSCRIBE_DELAY);
			} else {
				if (!getHDBNodeTable().primaryStore.get(getThisNodeName())?.replicates) {
					// if we are not fully replicating because it is turned off, make sure we set this
					// flag so that we actually turn on subscriptions if full replication is turned on
					is_fully_replicating = false;
				}
				const request = {
					type: 'unsubscribe-from-node',
					database: database_name,
					url: node.url,
				};
				if (worker) {
					worker.postMessage(request);
				} else unsubscribeFromNode(request);
			}
		}
	}
	// only assign these if we are on the main thread
	disconnectedFromNode = function (connection) {
		// if a node is disconnected, we need to reassign the subscriptions to another node
		// we try to do this in a deterministic way so that we don't end up with a cycle that short circuits
		// a node that may have more recent updates, so we try to go to the next node in the list, using
		// a sorted list of node names that all nodes should have and use.
		try {
			logger.info('Disconnected from node', connection.name, connection.url, 'finished', !!connection.finished);
			const node_map_keys = Array.from(node_map.keys());
			const node_names = node_map_keys.sort();
			const existing_index = node_names.indexOf(connection.name || urlToNodeName(connection.url));
			if (existing_index === -1) {
				logger.warn('Disconnected node not found in node map', connection.name, node_map_keys);
				return;
			}
			let db_replication_workers = connection_replication_map.get(connection.url);
			const existing_worker_entry = db_replication_workers?.get(connection.database);
			if (!existing_worker_entry) {
				logger.warn('Disconnected node not found in replication map', connection.database, db_replication_workers);
				return;
			}
			existing_worker_entry.connected = false;
			if (connection.finished) return; // intentionally closed connection
			const main_node = existing_worker_entry.nodes[0];
			if (!(main_node.replicates === true || main_node.replicates?.sends || main_node.subscriptions?.length)) {
				// no replication, so just return
				return;
			}
			let next_index = (existing_index + 1) % node_names.length;
			while (existing_index !== next_index) {
				const next_node_name = node_names[next_index];
				const next_node = node_map.get(next_node_name);
				db_replication_workers = connection_replication_map.get(next_node.url);
				const failover_worker_entry = db_replication_workers?.get(connection.database);
				if (!failover_worker_entry) {
					next_index = (next_index + 1) % node_names.length;
					continue;
				}
				const { worker, nodes } = failover_worker_entry;
				// record which node we are now redirecting to
				let has_moved_nodes = false;
				for (const node of existing_worker_entry.nodes) {
					if (nodes.some((n) => n.name === node.name)) {
						logger.info(`Disconnected node is already failing over to ${next_node_name} for ${connection.database}`);
						continue;
					}
					nodes.push(node);
					has_moved_nodes = true;
				}
				if (!has_moved_nodes) {
					logger.info(`Disconnected node ${connection.name} has no nodes to fail over to ${next_node_name}`);
					return;
				}
				existing_worker_entry.redirectingTo = failover_worker_entry;
				logger.info(`Failing over ${connection.database} from ${connection.name} to ${next_node_name}`);
				if (worker) {
					worker.postMessage({
						type: 'subscribe-to-node',
						database: connection.database,
						nodes,
					});
				} else subscribeToNode({ database: connection.database, nodes });
				return;
			}
			logger.warn('Unable to find any other node to fail over to', connection.name, connection.url);
		} catch (error) {
			logger.error('Error failing over node', error);
		}
	};

	connectedToNode = function (connection) {
		// Basically undo what we did in disconnectedFromNode and also update the latency
		const db_replication_workers = connection_replication_map.get(connection.url);
		const main_worker_entry = db_replication_workers?.get(connection.database);
		if (!main_worker_entry) {
			logger.warn(
				'Connected node not found in replication map, this may be because the node is being removed',
				connection.database,
				db_replication_workers
			);
			return;
		}
		main_worker_entry.connected = true;
		main_worker_entry.latency = connection.latency;
		if (main_worker_entry.redirectingTo) {
			const { worker, nodes } = main_worker_entry.redirectingTo;
			const subscription_to_remove = nodes.find((node) => node.name === connection.name);
			main_worker_entry.redirectingTo = null;
			if (subscription_to_remove) {
				nodes.splice(nodes.indexOf(subscription_to_remove), 1);
				if (worker) {
					worker.postMessage({
						type: 'subscribe-to-node',
						database: connection.database,
						nodes,
					});
				} else subscribeToNode({ database: connection.database, nodes });
			}
		}
	};
	onMessageByType('disconnected-from-node', disconnectedFromNode);
	onMessageByType('connected-to-node', connectedToNode);
	onMessageByType('request-cluster-status', requestClusterStatus);
}

/**
 * This is called when a request is made to get the cluster status. This should be executed only on the main thread
 * and will return the status of all replication connections (for each database)
 * @param message
 * @param port
 */
export function requestClusterStatus(message, port) {
	const connections = [];
	for (const [node_name, node] of node_map) {
		try {
			const db_replication_map = connection_replication_map.get(node.url);
			logger.info('Getting cluster status for', node_name, node.url, 'has dbs', db_replication_map?.size);
			const databases = [];
			if (db_replication_map) {
				for (const [database, { worker, connected, nodes, latency }] of db_replication_map) {
					databases.push({
						database,
						connected,
						latency,
						threadId: worker?.threadId,
						nodes: nodes.map((node) => node.name),
					});
				}

				const res = cloneDeep(node);
				res.database_sockets = databases;
				delete res.ca;
				delete res.node_name;
				delete res.__updatedtime__;
				delete res.__createdtime__;
				connections.push(res);
			}
		} catch (error) {
			logger.warn('Error getting cluster status for', node?.url, error);
		}
	}
	port?.postMessage({
		type: 'cluster-status',
		connections,
	});
	return { connections };
}

if (parentPort) {
	disconnectedFromNode = (connection) => {
		parentPort.postMessage({ type: 'disconnected-from-node', ...connection });
	};
	connectedToNode = (connection) => {
		parentPort.postMessage({ type: 'connected-to-node', ...connection });
	};
	onMessageByType('subscribe-to-node', (message) => {
		subscribeToNode(message);
	});
	onMessageByType('unsubscribe-from-node', (message) => {
		unsubscribeFromNode(message);
	});
}

export async function ensureNode(name: string, node) {
	const table = getHDBNodeTable();
	name = name ?? urlToNodeName(node.url);
	node.name = name;
	const existing = table.primaryStore.get(name);
	logger.info(`Ensuring node ${name} at ${node.url}, existing record:`, existing);
	if (!existing) {
		await table.put(node);
	} else {
		if (node.replicates) node.subscriptions = null; // if we are fully replicating, we don't need to have subscriptions
		for (const key in node) {
			if (existing[key] !== node[key] && key === 'subscriptions' && node[key] && existing[key]) {
				// Update any existing subscriptions or append to subscriptions array
				const new_subs = [];
				const existing_subs = cloneDeep(existing[key]);
				for (const new_sub of node[key]) {
					let match_found = false;
					for (const existing_sub of existing_subs) {
						if (
							(new_sub.database ?? new_sub.schema) === (existing_sub.database ?? existing_sub.schema) &&
							new_sub.table === existing_sub.table
						) {
							existing_sub.publish = new_sub.publish;
							existing_sub.subscribe = new_sub.subscribe;
							match_found = true;
							break;
						}
					}

					if (!match_found) new_subs.push(new_sub);
				}

				node.subscriptions = [...existing_subs, ...new_subs];
				break;
			}
		}
		logger.info(`Updating node ${name} at ${node.url}`);
		await table.patch(node);
	}
}
