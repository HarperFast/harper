/**
 * This is the entry module is responsible for replicating data between nodes. It is a source for tables that are replicated
 * A typical exchange should look like:
 * 1. Node A connects to node B, and sends its node name and the database name (and the mapping of its node id to short ids?)
 * 2. Node B sends back its node name and the mapping of its node id to short ids
 * 3. Node A sends a subscription request to node B
 * 3a. Node B may also send a subscription request to node A
 * 4. Node B sends back the table names and structures
 * 5. Node B sends back the audit records
 */

import {
	database,
	databases,
	table as defineTable,
	getDatabases,
	onUpdatedTable,
	table,
} from '../../resources/databases';
import { ID_PROPERTY, Resource } from '../../resources/Resource';
import { IterableEventQueue } from '../../resources/IterableEventQueue';
import { onMessageByType } from '../threads/manageThreads';
import {
	NodeReplicationConnection,
	replicateOverWS,
	database_subscriptions,
	table_update_listeners,
} from './replicationConnection';
import { server } from '../Server';
import env from '../../utility/environment/environmentManager';
import * as logger from '../../utility/logging/harper_logger';
import { X509Certificate } from 'crypto';
import { readFileSync } from 'fs';
import { EventEmitter } from 'events';
export { startOnMainThread } from './subscriptionManager';
import { subscribeToNodeUpdates, getHDBNodeTable } from './subscriptionManager';

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
	if (!getThisNodeName())
		throw new Error('Can not load replication without a node name (see replication.nodeName in the config)');
	assignReplicationSource(options);
	// noinspection JSVoidFunctionReturnValueUsed
	const ws_server = server.ws(
		(ws, request) => {
			replicateOverWS(ws, options, request?.user);
			ws.on('error', (error) => {
				if (error.code !== 'ECONNREFUSED') logger.error('Error in connection to ' + this.url, error.message);
			});
		},
		Object.assign(
			// We generally expect this to use the operations API ports (9925)
			{
				protocol: 'harperdb-replication-v1',
				mtls: true, // make sure that we request a certificate from the client
				// we set this very high (16x times the default) because it can be a bit expensive to switch back and forth
				// between push and pull mode
				highWaterMark: 256 * 1024,
			},
			options
		)
	);
	ws_server.mtlsConfig = Object.assign(
		{
			// define a handler for mTLS authorized connections, the primary means of authentication for replication connections
			authorizedHandler(request) {
				const node = getHDBNodeTable().primaryStore.get(request.peerCertificate.subject.CN);
				if (node) {
					request.user = node;
				}
				// fall through to the default auth handler
			},
		},
		ws_server.mtlsConfig
	);
	servers.push(ws_server);
	if (ws_server.setSecureContext) {
		let certificate_authorities = new Set();
		let last_ca_count = 0;
		// we need to stay up-to-date with any CAs that have been replicated across the cluster
		subscribeToNodeUpdates((node) => {
			if (node.ca) {
				// we only care about nodes that have a CA
				certificate_authorities.add(node.ca);
				// created a set of all the CAs that have been replicated, if changed, update the secure context
				if (certificate_authorities.size !== last_ca_count) {
					last_ca_count = certificate_authorities.size;
					ws_server.setSecureContext(Object.assign({ ca: Array.from(certificate_authorities) }, options));
				}
			}
		});
	}
}
export function disableReplication(disabled = true) {
	replication_disabled = disabled;
}
let subscribed_to_nodes;
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
	const enabled_databases = options?.databases ?? databases;
	for (const database_name in enabled_databases) {
		if (!enabled_databases[database_name]) continue;
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
	table.sourcedFrom(
		class Replicator extends Resource {
			/**
			 * This subscribes to the other nodes. Subscription events are notifications rather than
			 * requests for data changes, so they circumvent the validation and replication layers
			 * of the table classes.
			 */
			static connection: NodeReplicationConnection;
			static subscription: IterableEventQueue;
			static async subscribe() {
				const db_subscriptions = options.databaseSubscriptions || database_subscriptions;
				let subscription = db_subscriptions.get(db_name);
				const table_by_id = subscription?.tableById || [];
				table_by_id[table.tableId] = table;
				const resolve = subscription?.ready;
				if (!subscription?.auditStore) {
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
					if (resolve) resolve(subscription);
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
							const connection = getConnection(node_id, Replicator.subscription, db_name);
							return new Promise((resolve) => {
								connection.send({
									type: 'get',
									table: table.tableName,
									id: this[ID_PROPERTY],
									node_id,
								});
								connection.registerResponse(id, resolve);
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
const connections = new Map();
function getConnection(url, subscription, db_name) {
	let db_connections = connections.get(url);
	if (!db_connections) {
		connections.set(url, (db_connections = new Map()));
	}
	let connection = db_connections.get(db_name);
	if (connection) return connection;
	db_connections.set(db_name, (connection = new NodeReplicationConnection(url, subscription, db_name)));
	connection.connect();
	return connection;
}
export async function subscribeToNode(request) {
	let subscription_to_table = database_subscriptions.get(request.database);
	if (!subscription_to_table) {
		// Wait for it to be created
		subscription_to_table = await new Promise((resolve) => {
			logger.info('Waiting for subscription to database ' + request.database);
			database_subscriptions.set(request.database, { ready: resolve });
		});
	}
	let connection = getConnection(request.nodes[0].url, subscription_to_table, request.database);
	connection.subscribe(request.nodes, request.replicateByDefault);
}

export function getThisNodeName() {
	return env.get('replication_nodename') ?? urlToNodeName(env.get('replication_url'));
}
export function getThisNodeUrl() {
	return env.get('replication_url');
}
export function urlToNodeName(node_url) {
	if (node_url) return new URL(node_url).hostname; // this the part of the URL that is the node name, as we want it to match common name in the certificate
}
