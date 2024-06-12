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
	onRemovedDB,
} from '../../resources/databases';
import { ID_PROPERTY, Resource } from '../../resources/Resource';
import { IterableEventQueue } from '../../resources/IterableEventQueue';
import { onMessageByType } from '../threads/manageThreads';
import {
	NodeReplicationConnection,
	createWebSocket,
	OPERATION_REQUEST,
	awaiting_response,
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
import { subscribeToNodeUpdates, getHDBNodeTable, iterateRoutes, shouldReplicateToNode } from './knownNodes';
import { encode } from 'msgpackr';
import { CONFIG_PARAMS } from '../../utility/hdbTerms';
import { exportIdMapping } from './nodeIdMapping';
import { verifyCertAgainstCAs } from '../../security/keys';
import { rootCertificates } from 'node:tls';

export let cluster_certificate_authorities = new Map();
let replication_disabled;
let next_id = 1; // for request ids

export let servers = [];
export function start(options) {
	if (!options.port) options.port = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT);
	if (!options.securePort) options.securePort = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT);
	if (!getThisNodeName()) throw new Error('Can not load replication without a url (see replication.url in the config)');
	let route_by_hostname = new Map();
	for (let node of iterateRoutes(options)) {
		route_by_hostname.set(urlToNodeName(node.url), node);
	}
	assignReplicationSource(options);
	options = Object.assign(
		// We generally expect this to use the operations API ports (9925)
		{
			subProtocol: 'harperdb-replication-v1',
			mtls: true, // make sure that we request a certificate from the client
			isOperationsServer: true, // we default to using the operations server ports
		},
		options
	);
	// noinspection JSVoidFunctionReturnValueUsed
	const ws_servers = server.ws(async (ws, request, chain_completion) => {
		await chain_completion;
		let authorization = request?.user;
		if (!authorization) {
			let cert = request.peerX509Certificate;
			if (cert) {
				let ca = cluster_certificate_authorities.get(cert.issuer);
				if (ca ? cert.checkIssued(ca) : verifyCertAgainstCAs(cert)) {
					// TODO: We may also need to verify that the certificate has not expired and other validity checks
					let common_name = cert.subject.match(/CN=(.*)/)?.[1];
					authorization = common_name && getHDBNodeTable().primaryStore.get(common_name);
				}
			} else {
				// try by IP address
				authorization = getHDBNodeTable().primaryStore.get(request.ip) || route_by_hostname.get(request.ip);
			}
			if (!authorization && request._nodeRequest.socket.authorizationError)
				logger.error(
					'Error in authorizing incoming WS client connection',
					request._nodeRequest.socket.authorizationError
				);
		}
		replicateOverWS(ws, options, authorization);
		ws.on('error', (error) => {
			if (error.code !== 'ECONNREFUSED') logger.error('Error in connection to ' + this.url, error.message);
		});
	}, options);

	if (!cluster_certificate_authorities.addedRoot) {
		cluster_certificate_authorities.addedRoot = true;
		for (let ca of rootCertificates) {
			let x509 = new X509Certificate(ca);
			x509.asString = ca;
			cluster_certificate_authorities.set(x509.subject, x509);
		}
	}
	// we need to stay up-to-date with any CAs that have been replicated across the cluster
	subscribeToNodeUpdates((node) => {
		// TODO: handle removal of CAs?
		if (node?.ca) {
			// we only care about nodes that have a CA
			let x509 = new X509Certificate(node.ca);
			x509.asString = node.ca;
			cluster_certificate_authorities.set(x509.subject, x509);
		}
	});
}
export function disableReplication(disabled = true) {
	replication_disabled = disabled;
}
/**
 * Replication functions by acting as a "source" for tables. With replicated tables, the local tables are considered
 * a "cache" of the cluster's data. The tables don't resolve gets to the cluster, but they do propagate
 * writes and subscribe to the cluster.
 * This function will assign the NATS replicator as a source to all tables don't have an otherwise defined source (basically
 * any tables that aren't caching tables for another source).
 */
function assignReplicationSource(options) {
	if (replication_disabled) return;
	getDatabases();
	forEachReplicatedDatabase(options, (database, database_name) => {
		if (!database) {
			// the database was removed
			const db_subscriptions = options.databaseSubscriptions || database_subscriptions;
			for (let [url, db_connections] of connections) {
				let db_connection = db_connections.get(database_name);
				if (db_connection) {
					db_connection.subscribe([], false);
					db_connections.delete(database_name);
				}
			}
			db_subscriptions.delete(database_name);
			return;
		}
		for (const table_name in database) {
			const Table = database[table_name];
			setReplicator(database_name, Table, options);
			table_update_listeners.get(Table)?.forEach((listener) => listener(Table));
		}
	});
}

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
			static available(id) {
				return false; // conditionally set this is partial records
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
	if (subscription) {
		db_connections.set(db_name, (connection = new NodeReplicationConnection(url, subscription, db_name)));
		connection.connect();
		connection.once('finished', () => db_connections.delete(db_name));
		return connection;
	}
}

export async function sendOperationToNode(node, operation, options) {
	const socket = await createWebSocket(node.url, options);
	replicateOverWS(socket, {}, {});
	operation.requestId = next_id++;
	return new Promise((resolve, reject) => {
		socket.on('open', () => {
			socket.send(encode([OPERATION_REQUEST, operation]));
			awaiting_response.set(operation.requestId, { resolve, reject });
		});
		socket.on('error', (error) => {
			reject(error);
		});
		socket.on('close', (error) => {
			logger.error('Sending operation connection to ' + node.url + ' closed', error);
		});
	});
}
export async function subscribeToNode(request) {
	try {
		let subscription_to_table = database_subscriptions.get(request.database);
		if (!subscription_to_table) {
			// Wait for it to be created
			let ready;
			subscription_to_table = new Promise((resolve) => {
				logger.info('Waiting for subscription to database ' + request.database);
				ready = resolve;
			});
			subscription_to_table.ready = ready;
			database_subscriptions.set(request.database, subscription_to_table);
		}
		let connection = getConnection(request.nodes[0].url, await subscription_to_table, request.database);
		if (request.nodes[0].name === undefined) connection.tentativeNode = request.nodes[0]; // we don't have the node name yet
		connection.subscribe(
			request.nodes.filter((node) => {
				return shouldReplicateToNode(node, request.database);
			}),
			request.replicateByDefault
		);
	} catch (error) {
		logger.error('Error in subscription to node', request.nodes[0]?.url, error);
	}
}
export async function unsubscribeFromNode({ url, database }) {
	let connection = getConnection(url, null, database);
	if (connection) connection.unsubscribe();
}

let common_name_from_cert: string;
function getCommonNameFromCert() {
	if (common_name_from_cert !== undefined) return common_name_from_cert;
	const certificate_path =
		env.get(CONFIG_PARAMS.OPERATIONSAPI_TLS_CERTIFICATE) || env.get(CONFIG_PARAMS.TLS_CERTIFICATE);
	if (certificate_path) {
		// we can use this to get the hostname if it isn't provided by config
		let cert_parsed = new X509Certificate(readFileSync(certificate_path));
		let subject = cert_parsed.subject;
		return (common_name_from_cert = subject.match(/CN=(.*)/)?.[1] ?? null);
	}
}
let node_name;
export function getThisNodeName() {
	return (
		node_name ||
		(node_name =
			env.get('replication_nodename') ??
			urlToNodeName(env.get('replication_url')) ??
			getCommonNameFromCert() ??
			getHostFromListeningPort('operationsapi_network_secureport') ??
			getHostFromListeningPort('operationsapi_network_port') ??
			'127.0.0.1')
	);
}
Object.defineProperty(server, 'nodeName', {
	get() {
		return getThisNodeName();
	},
});
function getHostFromListeningPort(key) {
	let port = env.get(key);
	const last_colon = port?.lastIndexOf?.(':');
	if (last_colon > 0) return port.slice(0, last_colon);
}
function getPortFromListeningPort(key) {
	let port = env.get(key);
	const last_colon = port?.lastIndexOf?.(':');
	if (last_colon > 0) return +port.slice(last_colon + 1).replace(/[\[\]]/g, '');
	return +port;
}
export function getThisNodeId(audit_store: any) {
	return exportIdMapping(audit_store)?.[getThisNodeName()];
}
server.replication = {
	getThisNodeId,
	exportIdMapping,
};
export function getThisNodeUrl() {
	let url = env.get('replication_url');
	if (url) return url;
	let node_name = getThisNodeName();
	let port = getPortFromListeningPort('replication_port');
	if (port) return `ws://${node_name}:${port}`;
	port = getPortFromListeningPort('replication_secureport');
	if (port) return `wss://${node_name}:${port}`;
	port = getPortFromListeningPort('operationsapi_network_port');
	if (port) return `ws://${node_name}:${port}`;
	port = getPortFromListeningPort('operationsapi_network_secureport');
	if (port) return `wss://${node_name}:${port}`;
}
export function urlToNodeName(node_url) {
	if (node_url) return new URL(node_url).hostname; // this the part of the URL that is the node name, as we want it to match common name in the certificate
}
export function forEachReplicatedDatabase(options, callback) {
	for (const database_name of Object.getOwnPropertyNames(databases)) {
		forDatabase(database_name);
	}
	onRemovedDB((database_name) => {
		forDatabase(database_name);
	});
	return onUpdatedTable((Table, is_changed) => {
		forDatabase(Table.databaseName);
	});
	function forDatabase(database_name) {
		const database = databases[database_name];
		if (
			options?.databases === undefined ||
			options.databases === '*' ||
			options.databases.includes(database_name) ||
			!database
		)
			callback(database, database_name, true);
		else if (hasExplicitlyReplicatedTable(database_name)) callback(database, database_name, false);
	}
}
function hasExplicitlyReplicatedTable(database_name) {
	const database = databases[database_name];
	for (let table_name in database) {
		const table = database[table_name];
		if (table.replicate) return true;
	}
}
