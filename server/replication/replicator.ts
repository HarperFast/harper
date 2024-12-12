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

import { databases, getDatabases, onUpdatedTable, onRemovedDB } from '../../resources/databases';
import { ID_PROPERTY, Resource } from '../../resources/Resource';
import { IterableEventQueue } from '../../resources/IterableEventQueue';
import {
	NodeReplicationConnection,
	createWebSocket,
	OPERATION_REQUEST,
	replicateOverWS,
	database_subscriptions,
	table_update_listeners,
} from './replicationConnection';
import { server } from '../Server';
import env from '../../utility/environment/environmentManager';
import * as logger from '../../utility/logging/harper_logger';
import { X509Certificate } from 'crypto';
import { readFileSync } from 'fs';
export { startOnMainThread } from './subscriptionManager';
import { subscribeToNodeUpdates, getHDBNodeTable, iterateRoutes, shouldReplicateToNode } from './knownNodes';
import { CONFIG_PARAMS } from '../../utility/hdbTerms';
import { exportIdMapping } from './nodeIdMapping';
import * as tls from 'node:tls';
import { ServerError } from '../../utility/errors/hdbError';
import { isMainThread } from 'worker_threads';
import { Database } from 'lmdb';

let replication_disabled;
let next_id = 1; // for request ids

export const servers = [];
// This is the set of acceptable root certificates for replication, which includes the publicly trusted CAs if enabled
// and any CAs that have been replicated across the cluster
export const replication_certificate_authorities =
	env.get(CONFIG_PARAMS.REPLICATION_ENABLEROOTCAS) !== false ? new Set(tls.rootCertificates) : new Set();
/**
 * Start the replication server. This will start a WebSocket server that will accept replication requests from other nodes.
 * @param options
 */
export function start(options) {
	if (!options.port) options.port = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT);
	if (!options.securePort) options.securePort = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT);
	if (!getThisNodeName()) throw new Error('Can not load replication without a url (see replication.url in the config)');
	const route_by_hostname = new Map();
	for (const node of iterateRoutes(options)) {
		route_by_hostname.set(urlToNodeName(node.url), node);
	}
	assignReplicationSource(options);
	options = {
		// We generally expect this to use the operations API ports (9925)
		subProtocol: 'harperdb-replication-v1',
		mtls: true, // make sure that we request a certificate from the client
		isOperationsServer: true, // we default to using the operations server ports
		maxPayload: 10 * 1024 * 1024 * 1024, // 10 GB max payload, primarily to support replicating applications
		...options,
	};
	// noinspection JSVoidFunctionReturnValueUsed
	const ws_servers = server.ws(async (ws, request, chain_completion) => {
		await chain_completion;
		ws._socket.unref(); // we don't want the socket to keep the thread alive
		replicateOverWS(ws, options, request?.user);
		ws.on('error', (error) => {
			if (error.code !== 'ECONNREFUSED') logger.error('Error in connection to ' + this.url, error.message);
		});
	}, options);
	options.runFirst = true;
	// now setup authentication for the replication server, authorizing by certificate
	// or IP address and then falling back to standard authorization, we set up an http middleware listener
	server.http((request, next_handler) => {
		if (request.isWebSocket && request.headers.get('Sec-WebSocket-Protocol') === 'harperdb-replication-v1') {
			if (!request.authorized && request._nodeRequest.socket.authorizationError) {
				logger.error(
					`Incoming client connection from ${request.ip} did not have valid certificate, you may need turn on enableRootCAs in the config if you are using a publicly signed certificate, or add the CA to the server's trusted CAs`,
					request._nodeRequest.socket.authorizationError
				);
			}
			const hdb_nodes_store = getHDBNodeTable().primaryStore;
			// attempt to authorize by certificate common name, this is the most common means of auth
			if (request.authorized && request.peerCertificate.subject) {
				const subject = request.peerCertificate.subject;
				const node = subject && (hdb_nodes_store.get(subject.CN) || route_by_hostname.get(subject.CN));
				if (node) {
					request.user = node;
				} else {
					// technically if there are credentials, we could still allow the connection, but give a warning, because we don't usually do that
					logger.warn(
						`No node found for certificate common name ${subject.CN}, available nodes are ${Array.from(
							hdb_nodes_store
								.getRange({})
								.filter(({ value }) => value)
								.map(({ key }) => key)
						).join(', ')} and routes ${Array.from(route_by_hostname.keys()).join(
							', '
						)}, connection will require credentials.`
					);
				}
			} else {
				// try by IP address
				const node = hdb_nodes_store.get(request.ip) || route_by_hostname.get(request.ip);
				if (node) {
					request.user = node;
				} else {
					logger.warn(
						`No node found for IP address ${request.ip}, available nodes are ${Array.from(
							new Set([...hdb_nodes_store.getKeys(), ...route_by_hostname.keys()])
						).join(', ')}, connection will require credentials.`
					);
				}
			}
		}
		return next_handler(request);
	}, options);

	for (const ws_server of ws_servers) {
		// we need to keep track of the servers so we can update the secure contexts
		servers.push(ws_server);
		if (ws_server.secureContexts) {
			// we have secure contexts, so we can update the replication variants with the replication CAs
			const updateContexts = () => {
				// on any change to the list of replication CAs or the certificates, we update the replication security contexts
				// note that we do not do this for the main security contexts, because all the CAs
				// add a big performance penalty on connection setup
				const contexts_to_update = new Set(ws_server.secureContexts.values());
				if (ws_server.defaultContext) contexts_to_update.add(ws_server.defaultContext);
				for (const context of contexts_to_update) {
					try {
						const ca = Array.from(replication_certificate_authorities);
						// add the replication CAs (and root CAs) to any existing CAs for the context
						if (context.options.availableCAs) ca.push(...context.options.availableCAs.values());
						const tls_options =
							// make sure we use the overriden tls.createSecureContext
							// create a new security context with the extra CAs
							{ ...context.options, ca };
						context.replicationContext = tls.createSecureContext(tls_options);
					} catch (error) {
						logger.error('Error creating replication TLS config', error);
					}
				}
			};
			ws_server.secureContextsListeners.push(updateContexts);
			// we need to stay up-to-date with any CAs that have been replicated across the cluster
			monitorNodeCAs(updateContexts);
		}
	}
}
export function monitorNodeCAs(listener) {
	let last_ca_count = 0;
	subscribeToNodeUpdates((node) => {
		if (node?.ca) {
			// we only care about nodes that have a CA
			replication_certificate_authorities.add(node.ca);
			// created a set of all the CAs that have been replicated, if changed, update the secure context
			if (replication_certificate_authorities.size !== last_ca_count) {
				last_ca_count = replication_certificate_authorities.size;
				listener?.();
			} else if (env.get(CONFIG_PARAMS.REPLICATION_ENABLEROOTCAS) !== false) {
				// if there is no CA for the node, then we default to using the root CAs, unless it is explicitly disabled
				for (const cert of tls.rootCertificates) replication_certificate_authorities.add(cert);
			}
		}
	});
}
export function disableReplication(disabled = true) {
	replication_disabled = disabled;
}
export let enabled_databases;
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
	enabled_databases = options.databases;
	// we need to set up the replicator as a source for each database that is replicated
	forEachReplicatedDatabase(options, (database, database_name) => {
		if (!database) {
			// if no database, then the notification means the database was removed
			const db_subscriptions = options.databaseSubscriptions || database_subscriptions;
			for (const [url, db_connections] of connections) {
				const db_connection = db_connections.get(database_name);
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
export function setReplicator(db_name: string, table: any, options: any) {
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
				logger.trace('Setting up replicator subscription to database', db_name);
				if (!subscription?.auditStore) {
					// if and only if we are the first table for the database, then we set up the subscription.
					// We only need one subscription for the database
					// TODO: Eventually would be nice to have a real database subscription that delegated each specific table
					// event to each table
					this.subscription = subscription = new IterableEventQueue();
					db_subscriptions.set(db_name, subscription);
					subscription.tableById = table_by_id;
					subscription.auditStore = table.auditStore;
					subscription.dbisDB = table.dbisDB;
					subscription.databaseName = db_name;
					if (resolve) resolve(subscription);
					return subscription;
				}
				this.subscription = subscription;
			}
			static subscribeOnThisThread(worker_index, total_workers) {
				// we need a subscription on every thread because we could get subscription requests from any
				// incoming TCP connection
				return true;
			}

			/**
			 * This should be called when there is a local invalidated entry, or an entry that is known to be available
			 * elsewhere on the cluster, and will retrieve from the appropriate node
			 * @param query
			 */
			static async load(entry: any) {
				if (entry) {
					const residency_id = entry.residencyId;
					const residency = entry.residency || table.dbisDB.get([Symbol.for('residency_by_id'), residency_id]);
					if (residency) {
						let first_error: Error;
						const attempted_connections = new Set();
						do {
							// This loop is for trying multiple nodes if the first one fails. With each iteration, we add the node to the attempted_connections,
							// so after fails we progressively try the next best node each time.
							let best_connection: NodeReplicationConnection;
							for (const node_name of residency) {
								const connection = getConnectionByName(node_name, Replicator.subscription, db_name);
								// find a connection, needs to be connected and we haven't tried it yet
								if (connection?.isConnected && !attempted_connections.has(connection)) {
									// choose this as the best connection if latency is lower (or hasn't been tested yet)
									if (!best_connection || connection.latency < best_connection.latency) {
										best_connection = connection;
									}
								}
							}
							// if there are no connections left, throw an error
							if (!best_connection)
								throw first_error || new ServerError('No connection to any other nodes are available', 502);
							const request = {
								requestId: next_id++,
								table,
								entry,
								id: entry.key,
							};
							attempted_connections.add(best_connection);
							try {
								return await best_connection.getRecord(request);
							} catch (error) {
								// if we are still connected, must be a non-network error
								if (best_connection.isConnected) throw error;
								// if we got a network error, record it and try the next node (continuing through the loop)
								logger.warn('Error in load from node', node_name, error);
								if (!first_error) first_error = error;
							}
							// eslint-disable-next-line no-constant-condition
						} while (true);
					}
				}
			}
			static isReplicator = true;
		},
		{ intermediateSource: true }
	);
}
const connections = new Map();

/**
 * Get or create a connection to the specified node
 * @param url
 * @param subscription
 * @param db_name
 */
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
const node_name_to_db_connections = new Map();
/** Get connection by node name, using caching
 *
 * */
function getConnectionByName(node_name, subscription, db_name) {
	let connection = node_name_to_db_connections.get(node_name)?.get(db_name);
	if (connection) return connection;
	const node = getHDBNodeTable().primaryStore.get(node_name);
	if (node?.url) {
		connection = getConnection(node.url, subscription, db_name);
		// cache the connection
		node_name_to_db_connections.set(node_name, connections.get(node.url));
	}
	return connection;
}

export async function sendOperationToNode(node, operation, options) {
	if (!options) options = {};
	options.serverName = node.name;
	const socket = await createWebSocket(node.url, options);
	const session = replicateOverWS(socket, {}, {});
	return new Promise((resolve, reject) => {
		socket.on('open', () => {
			resolve(session.sendOperation(operation));
		});
		socket.on('error', (error) => {
			reject(error);
		});
		socket.on('close', (error) => {
			logger.error('Sending operation connection to ' + node.url + ' closed', error);
		});
	}).finally(() => {
		socket.close();
	});
}

/**
 * Subscribe to a node for a database, getting the necessary connection and subscription and signaling the start of the subscription
 * @param request
 */
export function subscribeToNode(request) {
	try {
		if (isMainThread) {
			logger.trace(
				`Subscribing on main thread (should not happen in multi-threaded instance)`,
				request.nodes[0].url,
				request.database
			);
		}
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
		const connection = getConnection(request.nodes[0].url, subscription_to_table, request.database);
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
export async function unsubscribeFromNode({ name, url, database }) {
	logger.trace(
		'Unsubscribing from node',
		name,
		url,
		database,
		'nodes',
		Array.from(getHDBNodeTable().primaryStore.getRange({}))
	);
	const db_connections = connections.get(url);
	if (db_connections) {
		const connection = db_connections.get(database);
		if (connection) {
			connection.unsubscribe();
			db_connections.delete(database);
		}
	}
}

let common_name_from_cert: string;
function getCommonNameFromCert() {
	if (common_name_from_cert !== undefined) return common_name_from_cert;
	const certificate_path =
		env.get(CONFIG_PARAMS.OPERATIONSAPI_TLS_CERTIFICATE) || env.get(CONFIG_PARAMS.TLS_CERTIFICATE);
	if (certificate_path) {
		// we can use this to get the hostname if it isn't provided by config
		const cert_parsed = new X509Certificate(readFileSync(certificate_path));
		const subject = cert_parsed.subject;
		return (common_name_from_cert = subject.match(/CN=(.*)/)?.[1] ?? null);
	}
}
let node_name;

/** Attempt to figure out the host/node name, using direct or indirect settings
 * @returns {string}
 */
export function getThisNodeName() {
	return (
		node_name ||
		(node_name =
			env.get('replication_hostname') ??
			urlToNodeName(env.get('replication_url')) ??
			getCommonNameFromCert() ??
			getHostFromListeningPort('operationsapi_network_secureport') ??
			getHostFromListeningPort('operationsapi_network_port') ??
			'127.0.0.1')
	);
}

export function clearThisNodeName() {
	node_name = undefined;
}

Object.defineProperty(server, 'hostname', {
	get() {
		return getThisNodeName();
	},
});
function getHostFromListeningPort(key) {
	const port = env.get(key);
	const last_colon = port?.lastIndexOf?.(':');
	if (last_colon > 0) return port.slice(0, last_colon);
}
function getPortFromListeningPort(key) {
	const port = env.get(key);
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
	const url = env.get('replication_url');
	if (url) return url;
	return hostnameToUrl(getThisNodeName());
}
export function hostnameToUrl(hostname) {
	let port = getPortFromListeningPort('replication_port');
	if (port) return `ws://${hostname}:${port}`;
	port = getPortFromListeningPort('replication_secureport');
	if (port) return `wss://${hostname}:${port}`;
	port = getPortFromListeningPort('operationsapi_network_port');
	if (port) return `ws://${hostname}:${port}`;
	port = getPortFromListeningPort('operationsapi_network_secureport');
	if (port) return `wss://${hostname}:${port}`;
}
export function urlToNodeName(node_url) {
	if (node_url) return new URL(node_url).hostname; // this the part of the URL that is the node name, as we want it to match common name in the certificate
}

/**
 * Iterate through all the databases and tables that are replicated, both those that exist now, and future databases that
 * are added or removed, calling the callback for each
 * @param options
 * @param callback
 */
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
		logger.trace('Checking replication status of ', database_name, options?.databases);
		if (
			options?.databases === undefined ||
			options.databases === '*' ||
			options.databases.includes(database_name) ||
			options.databases.some?.((db_config) => db_config.name === database_name) ||
			!database
		)
			callback(database, database_name, true);
		else if (hasExplicitlyReplicatedTable(database_name)) callback(database, database_name, false);
	}
}
function hasExplicitlyReplicatedTable(database_name) {
	const database = databases[database_name];
	for (const table_name in database) {
		const table = database[table_name];
		if (table.replicate) return true;
	}
}

/**
 * Get the last time that an audit record was added to the audit store
 * @param audit_store
 */
export function lastTimeInAuditStore(audit_store: Database) {
	for (const timestamp of audit_store.getKeys({
		limit: 1,
		reverse: true,
	})) {
		return timestamp;
	}
}

export async function replicateOperation(req) {
	const response = { message: '' };
	if (req.replicated) {
		req.replicated = false; // don't send a replicated flag to the nodes we are sending to
		logger.trace?.(
			'Replicating operation',
			req.operation,
			'to nodes',
			server.nodes.map((node) => node.name)
		);
		const replicated_results = await Promise.allSettled(
			server.nodes.map((node) => {
				// do all the nodes in parallel
				return sendOperationToNode(node, req);
			})
		);
		// map the settled results to the response
		response.replicated = replicated_results.map((settled_result, index) => {
			const result =
				settled_result.status === 'rejected'
					? { status: 'failed', reason: settled_result.reason.toString() }
					: settled_result.value;
			result.node = server.nodes[index]?.name; // add the node to the result so we know which node succeeded/failed
			return result;
		});
	}
	return response;
}
