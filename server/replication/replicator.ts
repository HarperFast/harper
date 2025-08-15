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

import { databases, getDatabases, onUpdatedTable, onRemovedDB } from '../../resources/databases.ts';
import { Resource } from '../../resources/Resource.ts';
import { IterableEventQueue } from '../../resources/IterableEventQueue.ts';
import {
	NodeReplicationConnection,
	createWebSocket,
	replicateOverWS,
	databaseSubscriptions,
	tableUpdateListeners,
	LATENCY_POSITION,
} from './replicationConnection.ts';
import { server } from '../Server.ts';
import env from '../../utility/environment/environmentManager.js';
import * as logger from '../../utility/logging/harper_logger.js';
import { X509Certificate } from 'crypto';
import { verifyCertificate } from '../../security/certificateVerification.ts';
import { readFileSync } from 'fs';
export { startOnMainThread } from './subscriptionManager.ts';
import {
	subscribeToNodeUpdates,
	getHDBNodeTable,
	iterateRoutes,
	shouldReplicateToNode,
	getReplicationSharedStatus,
} from './knownNodes.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import { exportIdMapping } from './nodeIdMapping.ts';
import * as tls from 'node:tls';
import { ServerError } from '../../utility/errors/hdbError.js';
import { isMainThread } from 'worker_threads';
import type { Database } from 'lmdb';
import { getHostnamesFromCertificate } from '../../security/keys.js';

let replicationDisabled;
let nextId = 1; // for request ids

export const servers = [];
// This is the set of acceptable root certificates for replication, which includes the publicly trusted CAs if enabled
// and any CAs that have been replicated across the cluster
export const replicationCertificateAuthorities =
	env.get(CONFIG_PARAMS.REPLICATION_ENABLEROOTCAS) !== false ? new Set(tls.rootCertificates) : new Set();
/**
 * Start the replication server. This will start a WebSocket server that will accept replication requests from other nodes.
 * @param options
 */
export function start(options) {
	if (!options.port && !options.securePort) {
		// if no replication ports are specified at all, default to using operations API ports
		options.port = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_PORT);
		options.securePort = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_SECUREPORT);
	}
	if (!getThisNodeName()) throw new Error('Can not load replication without a url (see replication.url in the config)');
	const routeByHostname = new Map();
	for (const node of iterateRoutes(options)) {
		routeByHostname.set(urlToNodeName(node.url), node);
	}
	assignReplicationSource(options);
	options = {
		// We generally expect this to use the same settings as the operations API port
		mtls: true, // make sure that we request a certificate from the client
		isOperationsServer: true, // we default to using the operations server ports
		maxPayload: 10 * 1024 * 1024 * 1024, // 10 GB max payload, primarily to support replicating applications
		...options,
	};
	// noinspection JSVoidFunctionReturnValueUsed
	// @ts-expect-error
	const wsServers = server.ws(async (ws, request, chainCompletion, next) => {
		logger.debug('Incoming WS connection received ' + request.url);
		if (request.headers.get('sec-websocket-protocol') !== 'harperdb-replication-v1') {
			return next(ws, request, chainCompletion);
		}
		await chainCompletion;
		ws._socket.unref(); // we don't want the socket to keep the thread alive
		replicateOverWS(ws, options, request?.user);
		ws.on('error', (error) => {
			if (error.code !== 'ECONNREFUSED') logger.error('Error in connection to ' + this.url, error.message);
		});
	}, options);
	options.runFirst = true;
	// now setup authentication for the replication server, authorizing by certificate
	// or IP address and then falling back to standard authorization, we set up an http middleware listener
	server.http(async (request, nextHandler) => {
		if (request.isWebSocket && request.headers.get('Sec-WebSocket-Protocol') === 'harperdb-replication-v1') {
			logger.debug('Incoming replication WS connection received, authorized: ' + request.authorized);
			if (!request.authorized && request._nodeRequest.socket.authorizationError) {
				logger.error(
					`Incoming client connection from ${request.ip} did not have valid certificate, you may need turn on enableRootCAs in the config if you are using a publicly signed certificate, or add the CA to the server's trusted CAs`,
					request._nodeRequest.socket.authorizationError
				);
			}
			const hdbNodesStore = getHDBNodeTable().primaryStore;
			// attempt to authorize by certificate common name, this is the most common means of auth
			if (request.authorized && request.peerCertificate.subjectaltname) {
				const hostnames = getHostnamesFromCertificate(request.peerCertificate);
				let node: any;
				for (const hostname of hostnames) {
					node = hostname && (hdbNodesStore.get(hostname) || routeByHostname.get(hostname));
					if (node) break;
				}
				if (node) {
					// Perform certificate verification using OCSP
					// Pass the full options object which contains mtls config - verifyCertificate will handle extraction
					const verificationResult = await verifyCertificate(request.peerCertificate, options);
					if (!verificationResult.valid) {
						logger.warn(
							'Certificate verification failed:',
							verificationResult.status,
							'for node',
							node.name,
							'certificate serial number',
							request.peerCertificate.serialNumber
						);
						return;
					}

					// Keep manual revocation check as a fallback
					if (node?.revoked_certificates?.includes(request.peerCertificate.serialNumber)) {
						logger.warn(
							'Revoked certificate used in attempt to connect to node',
							node.name,
							'certificate serial number',
							request.peerCertificate.serialNumber
						);
						return;
					} else {
						request.user = node;
					}
				} else {
					// technically if there are credentials, we could still allow the connection, but give a warning, because we don't usually do that
					logger.warn(
						`No node found for certificate common name/SANs: ${hostnames}, available nodes are ${Array.from(
							hdbNodesStore
								.getRange({})
								.filter(({ value }) => value)
								.map(({ key }) => key)
						).join(', ')} and routes ${Array.from(routeByHostname.keys()).join(
							', '
						)}, connection will require credentials.`
					);
				}
			} else {
				// try by IP address
				const node = hdbNodesStore.get(request.ip) || routeByHostname.get(request.ip);
				if (node) {
					request.user = node;
				} else {
					logger.warn(
						`No node found for IP address ${request.ip}, available nodes are ${Array.from(
							new Set([...hdbNodesStore.getKeys(), ...routeByHostname.keys()])
						).join(', ')}, connection will require credentials.`
					);
				}
			}
		}
		return nextHandler(request);
	}, options);

	// we need to keep track of the servers so we can update the secure contexts
	const contextUpdaters: (() => void)[] = [];
	// @ts-expect-error
	for (const wsServer of wsServers) {
		if (wsServer.secureContexts) {
			// we have secure contexts, so we can update the replication variants with the replication CAs
			const updateContexts = () => {
				// on any change to the list of replication CAs or the certificates, we update the replication security contexts
				// note that we do not do this for the main security contexts, because all the CAs
				// add a big performance penalty on connection setup
				const contextsToUpdate = new Set(wsServer.secureContexts.values());
				if (wsServer.defaultContext) contextsToUpdate.add(wsServer.defaultContext);
				for (const context of contextsToUpdate) {
					try {
						const ca = Array.from(replicationCertificateAuthorities);
						// add the replication CAs (and root CAs) to any existing CAs for the context
						if (context.options.availableCAs) ca.push(...context.options.availableCAs.values());
						const tlsOptions =
							// make sure we use the overriden tls.createSecureContext
							// create a new security context with the extra CAs
							{ ...context.options, ca };
						context.updatedContext = tls.createSecureContext(tlsOptions);
					} catch (error) {
						logger.error('Error creating replication TLS config', error);
					}
				}
			};
			wsServer.secureContextsListeners.push(updateContexts);
			// we need to stay up-to-date with any CAs that have been replicated across the cluster
			contextUpdaters.push(updateContexts);
			if (env.get(CONFIG_PARAMS.REPLICATION_ENABLEROOTCAS) !== false) {
				// if we are using root CAs, then we need to at least update the contexts for this even if none of the nodes have (explicit) CAs
				updateContexts();
			}
		}
	}
	// we always need to monitor for node changes, because this also does the essential step of setting up the server.shards
	monitorNodeCAs(() => {
		for (const updateContexts of contextUpdaters) updateContexts();
	});
}
export function monitorNodeCAs(listener: () => void) {
	let lastCaCount = 0;
	subscribeToNodeUpdates((node) => {
		if (node?.ca) {
			// we only care about nodes that have a CA
			replicationCertificateAuthorities.add(node.ca);
			// created a set of all the CAs that have been replicated, if changed, update the secure context
			if (replicationCertificateAuthorities.size !== lastCaCount) {
				lastCaCount = replicationCertificateAuthorities.size;
				listener?.();
			}
		}
	});
}
export function disableReplication(disabled = true) {
	replicationDisabled = disabled;
}
export let enabledDatabases;
/**
 * Replication functions by acting as a "source" for tables. With replicated tables, the local tables are considered
 * a "cache" of the cluster's data. The tables don't resolve gets to the cluster, but they do propagate
 * writes and subscribe to the cluster.
 * This function will assign the NATS replicator as a source to all tables don't have an otherwise defined source (basically
 * any tables that aren't caching tables for another source).
 */
function assignReplicationSource(options) {
	if (replicationDisabled) return;
	getDatabases();
	enabledDatabases = options.databases;
	// we need to set up the replicator as a source for each database that is replicated
	forEachReplicatedDatabase(options, (database, databaseName) => {
		if (!database) {
			// if no database, then the notification means the database was removed
			const dbSubscriptions = options.databaseSubscriptions || databaseSubscriptions;
			for (const [url, dbConnections] of connections) {
				const dbConnection = dbConnections.get(databaseName);
				if (dbConnection) {
					dbConnection.subscribe([], false);
					dbConnections.delete(databaseName);
				}
			}
			dbSubscriptions.delete(databaseName);
			return;
		}
		for (const tableName in database) {
			const Table = database[tableName];
			setReplicator(databaseName, Table, options);
			tableUpdateListeners.get(Table)?.forEach((listener) => listener(Table));
		}
	});
}

/**
 * Get/create a replication resource that can be assigned as a source to tables
 * @param tableName
 * @param dbName
 */
export function setReplicator(dbName: string, table: any, options: any) {
	if (!table) {
		return console.error(`Attempt to replicate non-existent table ${table.name} from database ${dbName}`);
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
				const dbSubscriptions = options.databaseSubscriptions || databaseSubscriptions;
				let subscription = dbSubscriptions.get(dbName);
				const tableById = subscription?.tableById || [];
				tableById[table.tableId] = table;
				const resolve = subscription?.ready;
				logger.trace('Setting up replicator subscription to database', dbName);
				if (!subscription?.auditStore) {
					// if and only if we are the first table for the database, then we set up the subscription.
					// We only need one subscription for the database
					// TODO: Eventually would be nice to have a real database subscription that delegated each specific table
					// event to each table
					this.subscription = subscription = new IterableEventQueue();
					dbSubscriptions.set(dbName, subscription);
					subscription.tableById = tableById;
					subscription.auditStore = table.auditStore;
					subscription.dbisDB = table.dbisDB;
					subscription.databaseName = dbName;
					if (resolve) resolve(subscription);
					return subscription;
				}
				this.subscription = subscription;
			}
			static subscribeOnThisThread(workerIndex, totalWorkers) {
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
					const residencyId = entry.residencyId;
					const residency: string[] = entry.residency || table.dbisDB.get([Symbol.for('residency_by_id'), residencyId]);
					if (residency) {
						let firstError: Error;
						const attemptedNodes = new Set<string>();
						do {
							// This loop is for trying multiple nodes if the first one fails. With each iteration, we add the node to the attemptedConnections,
							// so after fails we progressively try the next best node each time.
							let bestConnection: NodeReplicationConnection;
							let bestNode = '';
							let bestLatency = Infinity;
							for (const nodeName of residency) {
								if (attemptedNodes.has(nodeName)) continue;
								if (nodeName === server.hostname) continue; // don't both connecting to ourselves
								const connection = getRetrievalConnectionByName(nodeName, Replicator.subscription, dbName);
								// find a connection, needs to be connected and we haven't tried it yet
								if (connection?.isConnected) {
									// is connected and not ourselves
									const latency = getReplicationSharedStatus(table.auditStore, dbName, nodeName)[LATENCY_POSITION];
									// choose this as the best connection if latency is lower (or hasn't been tested yet)
									if (!bestConnection || latency < bestLatency) {
										bestConnection = connection;
										bestNode = nodeName;
										bestLatency = latency;
									}
								}
							}
							// if there are no connections left, throw an error
							if (!bestConnection)
								throw (
									firstError || new ServerError(`No connection to any other nodes are available: ${residency}`, 502)
								);
							const request = {
								requestId: nextId++,
								table,
								entry,
								id: entry.key,
							};
							attemptedNodes.add(bestNode);
							try {
								return await bestConnection.getRecord(request);
							} catch (error) {
								// if we are still connected, must be a non-network error
								if (bestConnection.isConnected) throw error;
								// if we got a network error, record it and try the next node (continuing through the loop)
								logger.warn('Error in load from node', node_name, error);
								if (!firstError) firstError = error;
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
 * @param dbName
 */
function getSubscriptionConnection(
	url: string,
	subscription: any,
	dbName: string,
	node_name?: string,
	authorization?: string
) {
	let dbConnections = connections.get(url);
	if (!dbConnections) {
		connections.set(url, (dbConnections = new Map()));
	}
	let connection = dbConnections.get(dbName);
	if (connection) return connection;
	if (subscription) {
		dbConnections.set(
			dbName,
			(connection = new NodeReplicationConnection(url, subscription, dbName, node_name, authorization))
		);
		connection.connect();
		connection.once('finished', () => dbConnections.delete(dbName));
		return connection;
	}
}
const nodeNameToRetrievalConnections = new Map<string, Map<string, NodeReplicationConnection>>();
/**
 * Get connection by node name, using caching
 * */
function getRetrievalConnectionByName(nodeName, subscription, dbName): NodeReplicationConnection {
	let dbConnections = nodeNameToRetrievalConnections.get(node_name);
	if (!dbConnections) {
		dbConnections = new Map();
		nodeNameToRetrievalConnections.set(node_name, dbConnections);
	}
	let connection = dbConnections.get(dbName);
	if (connection) return connection;
	const node = getHDBNodeTable().primaryStore.get(nodeName);
	if (node?.url) {
		connection = new NodeReplicationConnection(node.url, subscription, dbName, node_name, node.authorization);
		// cache the connection
		dbConnections.set(nodeName, connection);
		connection.connect();
		connection.once('finished', () => dbConnections.delete(dbName));
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
			logger.debug('Sending operation connection to ' + node.url + ' opened', operation);
			resolve(session.sendOperation(operation));
		});
		socket.on('error', (error) => {
			reject(error);
		});
		socket.on('close', (error) => {
			logger.info('Sending operation connection to ' + node.url + ' closed', error);
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
		let subscriptionToTable = databaseSubscriptions.get(request.database);
		if (!subscriptionToTable) {
			// Wait for it to be created
			let ready;
			subscriptionToTable = new Promise((resolve) => {
				logger.info('Waiting for subscription to database ' + request.database);
				ready = resolve;
			});
			subscriptionToTable.ready = ready;
			databaseSubscriptions.set(request.database, subscriptionToTable);
		}
		const connection = getSubscriptionConnection(
			request.nodes[0].url,
			subscriptionToTable,
			request.database,
			request.nodes[0].name,
			request.nodes[0].authorization
		);
		if (request.nodes[0].name === undefined) {
			// we don't have the node name yet
			connection.tentativeNode = request.nodes[0];
		} else {
			connection.nodeName = request.nodes[0].name;
		}
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
	const dbConnections = connections.get(url);
	if (dbConnections) {
		const connection = dbConnections.get(database);
		if (connection) {
			connection.unsubscribe();
			dbConnections.delete(database);
		}
	}
}

let commonNameFromCert: string;
function getCommonNameFromCert() {
	if (commonNameFromCert !== undefined) return commonNameFromCert;
	const certificatePath =
		env.get(CONFIG_PARAMS.OPERATIONSAPI_TLS_CERTIFICATE) || env.get(CONFIG_PARAMS.TLS_CERTIFICATE);
	if (certificatePath) {
		// we can use this to get the hostname if it isn't provided by config
		const certParsed = new X509Certificate(readFileSync(certificatePath));
		const subject = certParsed.subject;
		return (commonNameFromCert = subject.match(/CN=(.*)/)?.[1] ?? null);
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
	const lastColon = port?.lastIndexOf?.(':');
	if (lastColon > 0) return port.slice(0, lastColon);
}
function getPortFromListeningPort(key) {
	const port = env.get(key);
	const lastColon = port?.lastIndexOf?.(':');
	if (lastColon > 0) return +port.slice(lastColon + 1).replace(/[\[\]]/g, '');
	return +port;
}
export function getThisNodeId(auditStore: any) {
	return exportIdMapping(auditStore)?.[getThisNodeName()];
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
export function urlToNodeName(nodeUrl) {
	if (nodeUrl) return new URL(nodeUrl).hostname; // this the part of the URL that is the node name, as we want it to match common name in the certificate
}

/**
 * Iterate through all the databases and tables that are replicated, both those that exist now, and future databases that
 * are added or removed, calling the callback for each
 * @param options
 * @param callback
 */
export function forEachReplicatedDatabase(options, callback) {
	for (const databaseName of Object.getOwnPropertyNames(databases)) {
		forDatabase(databaseName);
	}
	onRemovedDB((databaseName) => {
		forDatabase(databaseName);
	});
	return onUpdatedTable((Table, isChanged) => {
		forDatabase(Table.databaseName);
	});
	function forDatabase(databaseName) {
		const database = databases[databaseName];
		logger.trace('Checking replication status of ', databaseName, options?.databases);
		if (
			options?.databases === undefined ||
			options.databases === '*' ||
			options.databases.includes(databaseName) ||
			options.databases.some?.((dbConfig) => dbConfig.name === databaseName) ||
			!database
		)
			callback(database, databaseName, true);
		else if (hasExplicitlyReplicatedTable(databaseName)) callback(database, databaseName, false);
	}
}
function hasExplicitlyReplicatedTable(databaseName) {
	const database = databases[databaseName];
	for (const tableName in database) {
		const table = database[tableName];
		if (table.replicate) return true;
	}
}

/**
 * Get the last time that an audit record was added to the audit store
 * @param auditStore
 */
export function lastTimeInAuditStore(auditStore: Database) {
	for (const timestamp of auditStore.getKeys({
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
		const replicatedResults = await Promise.allSettled(
			server.nodes.map((node) => {
				// do all the nodes in parallel
				return sendOperationToNode(node, req);
			})
		);
		// map the settled results to the response
		response.replicated = replicatedResults.map((settledResult, index) => {
			const result =
				settledResult.status === 'rejected'
					? { status: 'failed', reason: settledResult.reason.toString() }
					: settledResult.value;
			result.node = server.nodes[index]?.name; // add the node to the result so we know which node succeeded/failed
			return result;
		});
	}
	return response;
}
