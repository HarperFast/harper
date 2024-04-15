/**
 * This module is responsible for replicating data between nodes. It is a source for tables that are replicated
 * A typical exchange should look like:
 * 1. Node A connects to node B, and sends its node name and the database name (and the mapping of its node id to short ids?)
 * 2. Node B sends back its node name and the mapping of its node id to short ids
 * 3. Node A sends a subscription request to node B
 * 3a. Node B may also send a subscription request to node A
 * 4. Node B sends back the table names and structures
 * 5. Node B sends back the audit records
 */

import { database, table as defineTable, getDatabases, onUpdatedTable, table } from '../../resources/databases';
import { ID_PROPERTY, Resource } from '../../resources/Resource';
import { IterableEventQueue } from '../../resources/IterableEventQueue';
import { getWorkerIndex } from '../threads/manageThreads';
import {
	NodeReplicationConnection,
	replicateOverWS,
	database_subscriptions,
	table_update_listeners,
} from './replicationConnection';
import { server } from '../Server';
import env from '../../utility/environment/environmentManager';
import * as logger from '../../utility/logging/harper_logger';
import { ensureNode, forEachNode } from './knownNodes';
import { X509Certificate } from 'crypto';
import { readFileSync } from 'fs';

let replication_disabled;

export let servers = [];
export function start(options) {
	if (!options.port) options.port = env.get('operationsApi_network_port');
	if (!options.securePort) {
		options.securePort = env.get('operationsApi_network_securePort');
		const certificate = env.get('tls_certificate');
		// we can use this to get the hostname if it isn't provided by config
		let cert_parsed = new X509Certificate(readFileSync(certificate));
		let subject = cert_parsed.subject;
	}
	if (options?.manualAssignment) {
	} else {
		assignReplicationSource(options);
		// TODO: node_id should come from the hdb_nodes table
	}
	servers.push(
		server.ws(
			(ws, request) => {
				replicateOverWS(ws, options);
				ws.on('error', (error) => {
					if (error.code !== 'ECONNREFUSED') logger.error('Error in connection to ' + this.url, error.message);
				});
			},
			Object.assign(
				// We generally expect this to use the operations API ports (9925)
				{
					protocol: 'harperdb-replication-v1',
					mtls: true,
				},
				options
			)
		)
	);
}
export function disableReplication(disabled = true) {
	replication_disabled = disabled;
}
const MAX_INGEST_THREADS = 1;
let immediateNATSTransaction, subscribed_to_nodes;
/**
 * Replication functions by acting as a "source" for tables. With replicated tables, the local tables are considered
 * a "cache" of the cluster's data. The tables don't resolve gets to the cluster, but they do propagate
 * writes and subscribe to the cluster.
 * This function will assign the NATS replicator as a source to all tables don't have an otherwise defined source (basically
 * any tables that aren't caching tables for another source).
 */
function assignReplicationSource(options) {
	if (replication_disabled) return;
	const databases = getDatabases();
	for (const database_name in databases) {
		const database = databases[database_name];
		for (const table_name in database) {
			const Table = database[table_name];
			setReplicator(database_name, Table, options);
		}
	}
	onUpdatedTable((Table, is_changed) => {
		setReplicator(Table.databaseName, Table, options);
		if (is_changed) {
			table_update_listeners.get(Table)?.forEach((listener) => listener(Table));
		}
	});
	if (subscribed_to_nodes) return;
	subscribed_to_nodes = true;
} /*
onMessageFromWorkers((event) => {
	if (event.type === 'nats_update') {
		assignReplicationSource();
	}
});*/

/**
 * Get/create a replication resource that can be assigned as a source to tables
 * @param table_name
 * @param db_name
 */
export function setReplicator(db_name, table, options) {
	if (!table) {
		return console.error(`Attempt to replicate non-existent table ${table.name} from database ${db_name}`);
	}
	if (table.replicate === false || table.sources?.some((source) => source.isReplicator)) return;
	let source;
	// We may try to consult this to get the other nodes for back-compat
	// const { hub_routes } = getClusteringRoutes();
	const connections = [];
	table.sourcedFrom(
		class Replicator extends Resource {
			/**
			 * This subscribes to the other nodes. Subscription events are notifications rather than
			 * requests for data changes, so they circumvent the validation and replication layers
			 * of the table classes.
			 */
			static connection: NodeReplicationConnection;
			static async subscribe() {
				const db_subscriptions = options.databaseSubscriptions || database_subscriptions;
				let subscription = db_subscriptions.get(db_name);
				const table_by_id = subscription?.tableById || [];
				table_by_id[table.tableId] = table;
				if (!subscription) {
					// if and only if we are the first table for the database, then we set up the subscription.
					// We only need one subscription for the database
					// TODO: Eventually would be nice to have a real database subscription that delegated each specific table
					// event to each table
					subscription = this.subscription = new IterableEventQueue();
					db_subscriptions.set(db_name, subscription);
					subscription.tableById = table_by_id;
					subscription.auditStore = table.auditStore;
					subscription.dbisDB = table.dbisDB;
					subscription.databaseName = db_name;
					if (getWorkerIndex() < MAX_INGEST_THREADS) {
						// if we have our own URL, we can add it ourselves
						// ensureNode(this_url, option.routes);
						route_loop: for (const route of options.routes) {
							try {
								let url = typeof route === 'string' ? route : route.url;
								if (!url) {
									if (route.host) url = 'wss://' + route.host + ':' + (route.port || 9925);
									else {
										console.error('Invalid route, must specify a url or host (with port)');
										continue;
									}
								}
								ensureNode(url);
							} catch (error) {
								console.error(error);
							}
						}
						forEachNode((node) => {
							const connection = new NodeReplicationConnection(node.url, subscription, db_name);
							connections.push(connection);
							connection.connect();
						});
					}
					return subscription;
				}
			}
			static subscribeOnThisThread(worker_index, total_workers) {
				// we need a subscription on every thread because we could get subscription requests from any
				// incoming TCP connection
				return true;
			}
			get(query) {
				const entry = table.primaryStore.getEntry(this[ID_PROPERTY]);
				if (entry) {
					const residency_id = entry.residencyId;
					if (residency_id) {
						const residency = table.residencyStore.getEntry(residency_id);
						for (let node_id in residency) {
							return new Promise((resolve) => {
								Replicator.connection.send({
									type: 'get',
									table: table.tableName,
									id: this[ID_PROPERTY],
									node_id,
								});
								Replicator.connection.registerResponse(id, resolve);
							});
						}
					}
				}
			}
			static isReplicator = true;
		},
		{ intermediateSource: true }
	);
}
