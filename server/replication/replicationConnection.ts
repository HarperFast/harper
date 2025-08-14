import {
	getDatabases,
	databases,
	table as ensureTable,
	onUpdatedTable,
	onRemovedDB,
} from '../../resources/databases.ts';
import {
	createAuditEntry,
	Decoder,
	getLastRemoved,
	HAS_CURRENT_RESIDENCY_ID,
	HAS_PREVIOUS_RESIDENCY_ID,
	REMOTE_SEQUENCE_UPDATE,
	HAS_BLOBS,
	readAuditEntry,
} from '../../resources/auditStore.ts';
import { exportIdMapping, getIdOfRemoteNode, remoteToLocalNodeId } from './nodeIdMapping.ts';
import { whenNextTransaction } from '../../resources/transactionBroadcast.ts';
import {
	replicationCertificateAuthorities,
	forEachReplicatedDatabase,
	getThisNodeName,
	urlToNodeName,
	getThisNodeId,
	enabledDatabases,
} from './replicator.ts';
import env from '../../utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import { HAS_STRUCTURE_UPDATE, lastMetadata, METADATA } from '../../resources/RecordEncoder.ts';
import { decode, encode, Packr } from 'msgpackr';
import { WebSocket } from 'ws';
import { threadId } from 'worker_threads';
import { forComponent, errorToString } from '../../utility/logging/harper_logger.js';
import { disconnectedFromNode, connectedToNode, ensureNode } from './subscriptionManager.ts';
import { EventEmitter } from 'events';
import { createTLSSelector } from '../../security/keys.js';
import * as tls from 'node:tls';
import { getHDBNodeTable, getReplicationSharedStatus } from './knownNodes.ts';
import * as process from 'node:process';
import { isIP } from 'node:net';
import { recordAction } from '../../resources/analytics/write.ts';
import { decodeBlobsWithWrites, decodeWithBlobCallback, deleteBlob, getFileId } from '../../resources/blob.ts';
import { PassThrough } from 'node:stream';
import { getLastVersion } from 'lmdb';
import minimist from 'minimist';
const logger = forComponent('replication').conditional;

// these are the codes we use for the different commands
const SUBSCRIPTION_REQUEST = 129;
const NODE_NAME = 140;
const NODE_NAME_TO_ID_MAP = 141;
const DISCONNECT = 142;
const RESIDENCY_LIST = 130;
const TABLE_FIXED_STRUCTURE = 132;
const GET_RECORD = 133; // request a specific record
const GET_RECORD_RESPONSE = 134; // request a specific record
export const OPERATION_REQUEST = 136;
const OPERATION_RESPONSE = 137;
const SEQUENCE_ID_UPDATE = 143;
const COMMITTED_UPDATE = 144;
const DB_SCHEMA = 145;
const BLOB_CHUNK = 146;
export const CONFIRMATION_STATUS_POSITION = 0;
export const RECEIVED_VERSION_POSITION = 1;
export const RECEIVED_TIME_POSITION = 2;
export const SENDING_TIME_POSITION = 3;
export const LATENCY_POSITION = 4;
export const RECEIVING_STATUS_POSITION = 5;
export const RECEIVING_STATUS_WAITING = 0;
export const RECEIVING_STATUS_RECEIVING = 1;
const cli_args = minimist(process.argv);
const leaderUrl: string = cli_args.HDB_LEADER_URL ?? process.env.HDB_LEADER_URL;

export const tableUpdateListeners = new Map();
// This a map of the database name to the subscription object, for the subscriptions from our tables to the replication module
// when we receive messages from other nodes, we then forward them on to as a notification on these subscriptions
export const databaseSubscriptions = new Map();
const DEBUG_MODE = true;
// when we skip messages (usually because we aren't the originating node), we still need to occassionally send a sequence update
// so that catchup occurs more quickly
const SKIPPED_MESSAGE_SEQUENCE_UPDATE_DELAY = 300;
// The amount time to await after a commit before sending out a committed update (and aggregating all updates).
// We want it be fairly quick so we can let the sending node know that we have received and committed the update.
// (but still allow for batching so we aren't sending out a message for every update under load)
const COMMITTED_UPDATE_DELAY = 2;
const PING_INTERVAL = 30000;
let secureContexts: Map<string, tls.SecureContext>;
/**
 * Handles reconnection, and requesting catch-up
 */

type NodeSubscription = {
	name: string;
	replicateByDefault: boolean;
	tables: string[];
	startTime: number;
	endTime: number;
};

let replicationSecureContext: tls.SecureContext & { caCount?: number };

export async function createWebSocket(
	url: string,
	options: { authorization?: string; rejectUnauthorized?: boolean; serverName?: string }
) {
	const { authorization, rejectUnauthorized } = options || {};

	const node_name = getThisNodeName();
	let secureContext;
	if (url == null) {
		throw new TypeError(`Invalid URL: Expected a string URL for node "${node_name}" but received ${url}`);
	}

	if (url.includes('wss://')) {
		if (!secureContexts) {
			const SNICallback = createTLSSelector('operations-api');
			const secureTarget = {
				secureContexts: null,
			};
			await SNICallback.initialize(secureTarget);
			secureContexts = secureTarget.secureContexts;
		}
		secureContext = secureContexts.get(node_name);
		if (secureContext) {
			logger.debug?.('Creating web socket for URL', url, 'with certificate named:', secureContext.name);
		}
		if (!secureContext && rejectUnauthorized !== false) {
			throw new Error('Unable to find a valid certificate to use for replication to connect to ' + url);
		}
	}
	const headers = {};
	if (authorization) {
		headers.Authorization = authorization;
	}
	const wsOptions = {
		headers,
		localAddress: node_name?.startsWith('127.0') ? node_name : undefined, // this is to make sure we use the correct network interface when doing our local loopback testing
		servername: isIP(options?.serverName) ? undefined : options?.serverName, // use the node name for the SNI negotiation (as long as it is not an IP)
		noDelay: true, // we want to send the data immediately
		// we set this very high (2x times the v22 default) because it performs better
		highWaterMark: 128 * 1024,
		rejectUnauthorized: rejectUnauthorized !== false,
		secureContext: undefined,
	};
	if (secureContext) {
		// check to see if our cached secure context is still valid
		if (replicationSecureContext?.caCount !== replicationCertificateAuthorities.size) {
			// create a secure context and cache by the number of replication CAs (if that changes, we need to create a new secure context)
			replicationSecureContext = tls.createSecureContext({
				...secureContext.options,
				ca: [...replicationCertificateAuthorities, ...secureContext.options.availableCAs.values()], // add CA if secure context had one
			});
			replicationSecureContext.caCount = replicationCertificateAuthorities.size;
		}
		wsOptions.secureContext = replicationSecureContext;
	}
	return new WebSocket(url, 'harperdb-replication-v1', wsOptions);
}

const INITIAL_RETRY_TIME = 500;
/**
 * This represents a persistent connection to a node for replication, which handles
 * sockets that may be disconnected and reconnected
 */
export class NodeReplicationConnection extends EventEmitter {
	socket: WebSocket;
	startTime: number;
	retryTime = INITIAL_RETRY_TIME;
	retries = 0;
	isConnected = true; // we start out assuming we will be connected
	isFinished = false;
	nodeSubscriptions?: NodeSubscription[];
	latency = 0;
	replicateTablesByDefault: boolean;
	session: any; // this is a promise that resolves to the session object, which is the object that handles the replication
	sessionResolve: Function;
	sessionReject: Function;
	url: string;
	subscription: any;
	databaseName: string;
	nodeName?: string;
	authorization?: string;
	constructor(url: string, subscription: any, databaseName: string, nodeName?: string, authorization?: string) {
		super();
		this.url = url;
		this.subscription = subscription;
		this.databaseName = databaseName;
		this.authorization = authorization;
		this.nodeName = this.nodeName ?? urlToNodeName(url);
	}

	async connect() {
		if (!this.session) this.resetSession();
		const tables = [];
		// TODO: Need to do this specifically for each node
		this.socket = await createWebSocket(this.url, { serverName: this.nodeName, authorization: this.authorization });

		let session;
		logger.debug?.(`Connecting to ${this.url}, db: ${this.databaseName}, process ${process.pid}`);
		this.socket.on('open', () => {
			this.socket._socket.unref();
			// in normal startup, just use info, but adjust log level to warn if we were previously disconnected, because there was a warn message on the disconnect and we want to keep symmetry
			logger[this.isConnected ? 'info' : 'warn']?.(`Connected to ${this.url}, db: ${this.databaseName}`);
			this.retries = 0;
			this.retryTime = INITIAL_RETRY_TIME;
			// if we have already connected, we need to send a reconnected event
			if (this.nodeSubscriptions) {
				connectedToNode({
					name: this.nodeName,
					database: this.databaseName,
					url: this.url,
				});
			}
			this.isConnected = true;
			session = replicateOverWS(
				this.socket,
				{
					database: this.databaseName,
					subscription: this.subscription,
					url: this.url,
					connection: this,
					isSubscriptionConnection: this.nodeSubscriptions !== undefined,
				},
				{ replicates: true } // pre-authorized, but should only make publish: true if we are allowing reverse subscriptions
			);
			this.sessionResolve(session);
		});
		this.socket.on('error', (error) => {
			if (error.code === 'SELF_SIGNED_CERT_IN_CHAIN') {
				logger.warn?.(
					`Can not connect to ${this.url}, this server does not have a certificate authority for the certificate provided by ${this.url}`
				);
				error.isHandled = true;
			} else if (error.code !== 'ECONNREFUSED') {
				if (error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
					logger.error?.(
						`Can not connect to ${this.url}, the certificate provided by ${this.url} is not trusted, this node needs to be added to the cluster, or a certificate authority needs to be added`
					);
				else logger.error?.(`Error in connection to ${this.url} due to ${error.message}`);
			}
			this.sessionReject(error);
		});
		this.socket.on('close', (code, reasonBuffer) => {
			// if we get disconnected, notify subscriptions manager so we can reroute through another node
			if (this.isConnected) {
				if (this.nodeSubscriptions) {
					disconnectedFromNode({
						name: this.nodeName,
						database: this.databaseName,
						url: this.url,
						finished: this.socket.isFinished,
					});
				}
				this.isConnected = false;
			}
			this.removeAllListeners('subscriptions-updated');

			if (this.socket.isFinished) {
				this.isFinished = true;
				session?.end();
				this.emit('finished');
				return;
			}
			if (++this.retries % 20 === 1) {
				const reason = reasonBuffer?.toString();
				logger.warn?.(
					`${session ? 'Disconnected from' : 'Failed to connect to'} ${this.url} (db: "${this.databaseName}"), due to ${
						reason ? '"' + reason + '" ' : ''
					}(code: ${code})`
				);
			}
			session = null;
			this.resetSession();
			// try to reconnect
			setTimeout(() => {
				this.connect();
			}, this.retryTime).unref();
			this.retryTime += this.retryTime >> 8; // increase by 0.4% each time
		});
	}
	resetSession() {
		this.session = new Promise((resolve, reject) => {
			this.sessionResolve = resolve;
			this.sessionReject = reject;
		});
	}
	subscribe(nodeSubscriptions, replicateTablesByDefault) {
		this.nodeSubscriptions = nodeSubscriptions;
		this.replicateTablesByDefault = replicateTablesByDefault;
		this.emit('subscriptions-updated', nodeSubscriptions);
	}
	unsubscribe() {
		this.socket.isFinished = true;
		this.socket.close(1008, 'No longer subscribed');
	}

	getRecord(request) {
		return this.session.then((session) => {
			return session.getRecord(request);
		});
	}
}

/**
 * This handles both incoming and outgoing WS allowing either one to issue a subscription and get replication and/or handle subscription requests
 */
export function replicateOverWS(ws, options, authorization) {
	const p = options.port || options.securePort;
	const connectionId =
		(process.pid % 1000) +
		'-' +
		threadId +
		(p ? 's:' + p : 'c:' + options.url?.slice(-4)) +
		' ' +
		Math.random().toString().slice(2, 3);
	logger.debug?.(connectionId, 'Initializing replication connection', authorization);
	let encodingStart = 0;
	let encodingBuffer = Buffer.allocUnsafeSlow(1024);
	let position = 0;
	let dataView = new DataView(encodingBuffer.buffer, 0, 1024);
	let databaseName = options.database;
	const dbSubscriptions = options.databaseSubscriptions || databaseSubscriptions;
	let auditStore: any;
	let replicationSharedStatus: Float64Array;
	// this is the subscription that the local table makes to this replicator, and incoming messages
	// are sent to this subscription queue:
	let subscribed = false;
	let tableSubscriptionToReplicator = options.subscription;
	if (tableSubscriptionToReplicator?.then)
		tableSubscriptionToReplicator.then((sub) => {
			tableSubscriptionToReplicator = sub;
			if (tableSubscriptionToReplicator.auditStore) auditStore = tableSubscriptionToReplicator.auditStore;
		});
	let tables = options.tables || (databaseName && getDatabases()[databaseName]);
	let remoteNodeName: string;
	if (!authorization) {
		logger.error?.(connectionId, 'No authorization provided');
		// don't send disconnect because we want the client to potentially retry
		close(1008, 'Unauthorized');
		return;
	}
	const awaitingResponse = new Map();
	let receivingDataFromNodeIds = [];
	remoteNodeName = authorization.name;
	if (remoteNodeName && options.connection) options.connection.nodeName = remoteNodeName;
	let lastSequenceIdReceived, lastSequenceIdCommitted;
	let sendPingInterval, receivePingTimer, lastPingTime, skippedMessageSequenceUpdateTimer;
	let blobsTimer;
	const DELAY_CLOSE_TIME = 5000;
	let delayedClose: NodeJS.Timeout;
	let lastMessageTime = 0;
	// track bytes read and written so we can verify if a connection is really dead on pings
	let bytesRead = 0;
	let bytesWritten = 0;
	const blobTimeout = env.get(CONFIG_PARAMS.REPLICATION_BLOBTIMEOUT) ?? 120000;
	const blobsInFlight = new Map();
	const outstandingBlobsToFinish: Promise<void>[] = [];
	let outstandingBlobsBeingSent = 0;
	let blobSentCallback: (v?: any) => void;
	if (options.url) {
		const sendPing = () => {
			// if we have not received a message in the last ping interval, we should terminate the connection (but check to make sure we aren't just waiting for other data to flow)
			if (lastPingTime && bytesRead === ws._socket?.bytesRead && bytesWritten === ws._socket?.bytesWritten)
				ws.terminate(); // timeout
			else {
				lastPingTime = performance.now();
				ws.ping();
				bytesRead = ws._socket?.bytesRead;
				bytesWritten = ws._socket?.bytesWritten;
			}
		};
		sendPingInterval = setInterval(sendPing, PING_INTERVAL).unref();
		sendPing(); // send the first ping immediately so we can measure latency
	} else {
		resetPingTimer();
	}
	ws._socket?.setMaxListeners(200); // we should allow a lot of drain listeners for concurrent blob streams
	function resetPingTimer() {
		clearTimeout(receivePingTimer);
		bytesRead = ws._socket?.bytesRead;
		bytesWritten = ws._socket?.bytesWritten;
		receivePingTimer = setTimeout(() => {
			// double check to make sure we aren't just waiting for other data to flow
			if (bytesRead === ws._socket?.bytesRead && bytesWritten === ws._socket?.bytesWritten) {
				logger.warn?.(`Timeout waiting for ping from ${remoteNodeName}, terminating connection and reconnecting`);
				ws.terminate();
			}
		}, PING_INTERVAL * 2).unref();
	}
	function getSharedStatus() {
		if (!remoteNodeName || !databaseName) {
			return;
		}
		if (!replicationSharedStatus) {
			replicationSharedStatus = getReplicationSharedStatus(auditStore, databaseName, remoteNodeName);
		}
		return replicationSharedStatus;
	}
	if (databaseName) {
		setDatabase(databaseName);
	}
	let schemaUpdateListener, dbRemovalListener;
	const tableDecoders = [];
	const remoteTableById = [];
	let receivingDataFromNodeNames;
	const residencyMap = [];
	const sentResidencyLists = [];
	const receivedResidencyLists = [];
	const MAX_OUTSTANDING_COMMITS = 150; // maximum before requesting that other nodes pause
	const MAX_OUTSTANDING_BLOBS_BEING_SENT = 25;
	let outstandingCommits = 0;
	let lastStructureLength = 0;
	let replicationPaused = false;
	let subscriptionRequest, auditSubscription;
	let nodeSubscriptions;
	let remoteShortIdToLocalId: Map<number, number>;
	ws.on('message', (body) => {
		// A replication header should begin with either a transaction timestamp or messagepack message of
		// of an array that begins with the command code
		lastMessageTime = performance.now();
		try {
			const decoder = (body.dataView = new Decoder(body.buffer, body.byteOffset, body.byteLength));
			if (body[0] > 127) {
				// not a transaction, special message
				const message = decode(body);
				const [command, data, tableId] = message;
				switch (command) {
					case NODE_NAME: {
						if (data) {
							// this is the node name
							if (remoteNodeName) {
								if (remoteNodeName !== data) {
									logger.error?.(
										connectionId,
										`Node name mismatch, expecting to connect to ${remoteNodeName}, but peer reported name as ${data}, disconnecting`
									);
									ws.send(encode([DISCONNECT]));
									close(1008, 'Node name mismatch');
									return;
								}
							} else {
								remoteNodeName = data;
								if (options.connection?.tentativeNode) {
									// if this was a tentative node, we need to update the node name
									const nodeToAdd = options.connection.tentativeNode;
									nodeToAdd.name = remoteNodeName;
									options.connection.tentativeNode = null;
									ensureNode(remoteNodeName, nodeToAdd);
								}
							}
							if (options.connection) options.connection.nodeName = remoteNodeName;
							//const url = message[3] ?? thisNodeUrl;
							logger.debug?.(connectionId, 'received node name:', remoteNodeName, 'db:', databaseName ?? message[2]);
							if (!databaseName) {
								// this means we are the server
								try {
									setDatabase((databaseName = message[2]));
									if (databaseName === 'system') {
										schemaUpdateListener = forEachReplicatedDatabase(options, (database, databaseName) => {
											if (checkDatabaseAccess(databaseName)) sendDBSchema(databaseName);
										});
										ws.on('close', () => {
											schemaUpdateListener?.remove();
										});
									}
								} catch (error) {
									// if this fails, we should close the connection and indicate that we should not reconnect
									logger.warn?.(connectionId, 'Error setting database', error);
									ws.send(encode([DISCONNECT]));
									close(1008, error.message);
									return;
								}
							}
							sendSubscriptionRequestUpdate();
						}
						break;
					}
					case DB_SCHEMA: {
						logger.debug?.(
							connectionId,
							'Received table definitions for',
							data.map((t) => t.table)
						);
						for (const tableDefinition of data) {
							const databaseName = message[2];
							tableDefinition.database = databaseName;
							let table: any;
							if (checkDatabaseAccess(databaseName)) {
								if (databaseName === 'system') {
									// for system connection, we only update new tables
									if (!databases[databaseName]?.[tableDefinition.table])
										table = ensureTableIfChanged(tableDefinition, databases[databaseName]?.[tableDefinition.table]);
								} else {
									table = ensureTableIfChanged(tableDefinition, databases[databaseName]?.[tableDefinition.table]);
								}
								if (!auditStore) auditStore = table?.auditStore;
								if (!tables) tables = getDatabases()?.[databaseName];
							}
						}
						break;
					}
					case DISCONNECT:
						close();
						break;
					case OPERATION_REQUEST:
						try {
							const isAuthorizedNode = authorization?.replicates || authorization?.subscribers || authorization?.name;
							logger.debug?.('Received operation request', data, 'from', remoteNodeName);
							server.operation(data, { user: authorization }, !isAuthorizedNode).then(
								(response) => {
									if (Array.isArray(response)) {
										// convert an array to an object so we can have a top-level requestId properly serialized
										response = { results: response };
									}
									response.requestId = data.requestId;
									ws.send(encode([OPERATION_RESPONSE, response]));
								},
								(error) => {
									ws.send(
										encode([
											OPERATION_RESPONSE,
											{
												requestId: data.requestId,
												error: errorToString(error),
											},
										])
									);
								}
							);
						} catch (error) {
							ws.send(
								encode([
									OPERATION_RESPONSE,
									{
										requestId: data.requestId,
										error: errorToString(error),
									},
								])
							);
						}
						break;
					case OPERATION_RESPONSE:
						const { resolve, reject } = awaitingResponse.get(data.requestId);
						if (data.error) reject(new Error(data.error));
						else resolve(data);
						awaitingResponse.delete(data.requestId);
						break;
					case TABLE_FIXED_STRUCTURE:
						const tableName = message[3];
						if (!tables) {
							if (databaseName) logger.error?.(connectionId, 'No database found for', databaseName);
							else logger.error?.(connectionId, 'Database name never received');
							close();
							return;
						}
						let table = tables[tableName];
						table = ensureTableIfChanged(
							{
								table: tableName,
								database: databaseName,
								attributes: data.attributes,
								schemaDefined: data.schemaDefined,
							},
							table
						);
						// replication messages come across in binary format of audit log entries from the source node,
						// so we need to have the same structure and decoder configuration to decode them. We keep a map
						// of the table id to the decoder so we can decode the binary data for each table.
						tableDecoders[tableId] = {
							name: tableName,
							decoder: new Packr({
								useBigIntExtension: true,
								randomAccessStructure: true,
								freezeData: true,
								typedStructs: data.typedStructs,
								structures: data.structures,
							}),
							getEntry(id) {
								return table.primaryStore.getEntry(id);
							},
							rootStore: table.primaryStore.rootStore,
						};
						break;
					case NODE_NAME_TO_ID_MAP:
						// this is the mapping of node names to short local ids. if there is no auditStore (yet), just make an empty map, but not sure why that would happen.
						remoteShortIdToLocalId = auditStore ? remoteToLocalNodeId(data, auditStore) : new Map();
						receivingDataFromNodeNames = message[2];
						logger.debug?.(
							connectionId,
							`Acknowledged subscription request, receiving messages for nodes: ${receivingDataFromNodeNames}`
						);
						break;
					case RESIDENCY_LIST:
						// we need to keep track of the remote node's residency list by id
						const residencyId = tableId;
						receivedResidencyLists[residencyId] = data;
						break;
					case COMMITTED_UPDATE:
						// we need to record the sequence number that the remote node has received
						getSharedStatus()[CONFIRMATION_STATUS_POSITION] = data;
						logger.trace?.(connectionId, 'received and broadcasting committed update', data);
						getSharedStatus().buffer.notify();
						break;
					case SEQUENCE_ID_UPDATE:
						// we need to record the sequence number that the remote node has received
						lastSequenceIdReceived = data;
						tableSubscriptionToReplicator.send({
							type: 'end_txn',
							localTime: lastSequenceIdReceived,
							remoteNodeIds: receivingDataFromNodeIds,
						});
						break;
					case BLOB_CHUNK: {
						// this is a blob chunk, we need to write it to the blob store
						const blobInfo = message[1];
						const { fileId, size, finished, error } = blobInfo;
						let stream = blobsInFlight.get(fileId);
						logger.debug?.(
							'Received blob',
							fileId,
							'has stream',
							!!stream,
							'connectedToBlob',
							!!stream?.connectedToBlob,
							'length',
							message[2].length,
							'finished',
							finished
						);

						if (!stream) {
							stream = new PassThrough();
							stream.expectedSize = size;
							blobsInFlight.set(fileId, stream);
						}
						stream.lastChunk = Date.now();
						const blobBody = message[2];
						recordAction(
							blobBody.byteLength,
							'bytes-received',
							`${remoteNodeName}.${databaseName}`,
							'replication',
							'blob'
						);
						try {
							if (finished) {
								if (error) {
									stream.on('error', () => {}); // don't treat this as an uncaught error
									stream.destroy(new Error('Blob error: ' + error));
								} else stream.end(blobBody);
								if (stream.connectedToBlob) blobsInFlight.delete(fileId);
							} else stream.write(blobBody);
						} catch (error) {
							logger.error?.(
								`Error receiving blob for ${stream.recordId} from ${remoteNodeName} and streaming to storage`,
								error
							);
							blobsInFlight.delete(fileId);
						}
						break;
					}
					case GET_RECORD: {
						// this is a request for a record, we need to send it back
						const requestId = data;
						let responseData: Buffer;
						try {
							const recordId = message[3];
							const table = remoteTableById[tableId] || (remoteTableById[tableId] = tables[message[4]]);
							if (!table) {
								return logger.warn?.('Unknown table id trying to handle record request', tableId);
							}
							// we are sending raw binary data back, so we have to send the typed structure information so the
							// receiving side can properly decode it. We only need to send this once until it changes again, so we can check if the structure
							// has changed. It will only grow, so we can just check the length.
							const structuresBinary = table.primaryStore.getBinaryFast(Symbol.for('structures'));
							const structureLength = structuresBinary?.length ?? 0;
							if (structureLength > 0 && structureLength !== lastStructureLength) {
								lastStructureLength = structureLength;
								const structure = decode(structuresBinary);
								ws.send(
									encode([
										TABLE_FIXED_STRUCTURE,
										{
											typedStructs: structure.typed,
											structures: structure.named,
										},
										tableId,
										table.tableName,
									])
								);
							}
							// we might want to prefetch here
							const binaryEntry = table.primaryStore.getBinaryFast(recordId);
							if (binaryEntry) {
								let valueBuffer = table.primaryStore.decoder.decode(binaryEntry, { valueAsBuffer: true });
								const entry: any = lastMetadata || {};
								entry.version = getLastVersion();
								if (lastMetadata && lastMetadata[METADATA] & HAS_BLOBS) {
									// if there are blobs, we need to find them and send their contents
									// but first, the decoding process can destroy our buffer above, so we need to copy it
									valueBuffer = Buffer.from(valueBuffer);
									decodeWithBlobCallback(
										() => table.primaryStore.decoder.decode(binaryEntry),
										sendBlobs,
										table.primaryStore.rootStore
									);
								}
								responseData = encode([
									GET_RECORD_RESPONSE,
									requestId,
									{
										value: valueBuffer,
										expiresAt: entry.expiresAt,
										version: entry.version,
										residencyId: entry.residencyId,
										nodeId: entry.nodeId,
										user: entry.user,
									},
								]);
							} else {
								responseData = encode([GET_RECORD_RESPONSE, requestId]);
							}
						} catch (error) {
							responseData = encode([
								GET_RECORD_RESPONSE,
								requestId,
								{
									error: error.message,
								},
							]);
						}
						ws.send(responseData);
						break;
					}
					case GET_RECORD_RESPONSE: {
						// this is a response to a record request, we need to resolve the promise
						const { resolve, reject, tableId, key } = awaitingResponse.get(message[1]);
						const entry = message[2];
						if (entry?.error) reject(new Error(entry.error));
						else if (entry) {
							let blobsToDelete: any[];
							decodeBlobsWithWrites(
								() => {
									const record = tableDecoders[tableId].decoder.decode(entry.value);
									entry.value = record;
									entry.key = key;
									if (!resolve(entry)) {
										// if it was not moved locally, clean up any blobs that were written
										if (blobsToDelete) {
											// The blobs are asynchronously used, and it is very difficult to actually know
											// when they can be safely deleted (we might be able to use a WeakRef with CleanupRegistry).
											// For now, this should give us plenty of time and provide adequate cleanup measures
											setTimeout(() => blobsToDelete.forEach(deleteBlob), 60000).unref();
										}
									}
								},
								(remoteBlob) => {
									const localBlob = receiveBlobs(remoteBlob, key); // receive the blob;
									// track the blobs that were written in case we need to delete them if the record is not moved locally
									if (!blobsToDelete) blobsToDelete = [];
									blobsToDelete.push(localBlob);
									return localBlob;
								}
							);
						} else resolve();
						awaitingResponse.delete(message[1]);
						break;
					}
					case SUBSCRIPTION_REQUEST: {
						nodeSubscriptions = data;
						// permission check to make sure that this node is allowed to subscribe to this database, that is that
						// we have publish permission for this node/database
						let subscriptionToHdbNodes, whenSubscribedToHdbNodes;
						let closed = false;
						if (tableSubscriptionToReplicator) {
							if (databaseName !== tableSubscriptionToReplicator.databaseName && !tableSubscriptionToReplicator.then) {
								logger.error?.(
									'Subscription request for wrong database',
									databaseName,
									tableSubscriptionToReplicator.databaseName
								);
								return;
							}
						} else tableSubscriptionToReplicator = dbSubscriptions.get(databaseName);
						logger.debug?.(connectionId, 'received subscription request for', databaseName, 'at', nodeSubscriptions);
						if (!tableSubscriptionToReplicator) {
							// Wait for it to be created
							let ready;
							tableSubscriptionToReplicator = new Promise((resolve) => {
								logger.debug?.('Waiting for subscription to database ' + databaseName);
								ready = resolve;
							});
							tableSubscriptionToReplicator.ready = ready;
							databaseSubscriptions.set(databaseName, tableSubscriptionToReplicator);
						}
						if (authorization.name) {
							whenSubscribedToHdbNodes = getHDBNodeTable().subscribe(authorization.name);
							whenSubscribedToHdbNodes.then(
								async (subscription) => {
									subscriptionToHdbNodes = subscription;
									for await (const event of subscriptionToHdbNodes) {
										const node = event.value;
										if (
											!(
												node?.replicates === true ||
												node?.replicates?.receives ||
												node?.subscriptions?.some(
													// TODO: Verify the table permissions for each table listed in the subscriptions
													(sub) => (sub.database || sub.schema) === databaseName && sub.publish !== false
												)
											)
										) {
											closed = true;
											ws.send(encode([DISCONNECT]));
											close(1008, `Unauthorized database subscription to ${databaseName}`);
											return;
										}
									}
								},
								(error) => {
									logger.error?.(connectionId, 'Error subscribing to HDB nodes', error);
								}
							);
						} else if (!(authorization?.role?.permission?.super_user || authorization.replicates)) {
							ws.send(encode([DISCONNECT]));
							close(1008, `Unauthorized database subscription to ${databaseName}`);
							return;
						}

						if (auditSubscription) {
							// any subscription will supersede the previous subscription, so end that one
							logger.debug?.(connectionId, 'stopping previous subscription', databaseName);
							auditSubscription.emit('close');
						}
						if (nodeSubscriptions.length === 0)
							// this means we are unsubscribing
							return;
						const firstNode = nodeSubscriptions[0];
						const tableToTableEntry = (table) => {
							if (
								table &&
								(firstNode.replicateByDefault
									? !firstNode.tables.includes(table.tableName)
									: firstNode.tables.includes(table.tableName))
							) {
								return { table };
							}
						};
						const currentTransaction = { txnTime: 0 };
						let subscribedNodeIds, tableById;
						let currentSequenceId = Infinity; // the last sequence number in the audit log that we have processed, set this with a finite number from the subscriptions
						let sentSequenceId; // the last sequence number we have sent
						const sendAuditRecord = (auditRecord, localTime) => {
							if (auditRecord.type === 'end_txn') {
								if (currentTransaction.txnTime) {
									if (encodingBuffer[encodingStart] !== 66) {
										logger.error?.('Invalid encoding of message');
									}
									writeInt(9); // replication message of nine bytes long
									writeInt(REMOTE_SEQUENCE_UPDATE); // action id
									writeFloat64((sentSequenceId = localTime)); // send the local time so we know what sequence number to start from next time.
									sendQueuedData();
								}
								encodingStart = position;
								currentTransaction.txnTime = 0;
								return; // end of transaction, nothing more to do
							}
							const nodeId = auditRecord.nodeId;
							const tableId = auditRecord.tableId;
							let tableEntry = tableById[tableId];
							if (!tableEntry) {
								tableEntry = tableById[tableId] = tableToTableEntry(tableSubscriptionToReplicator.tableById[tableId]);
								if (!tableEntry) {
									return logger.debug?.('Not subscribed to table', tableId);
								}
							}
							const table = tableEntry.table;
							const primaryStore = table.primaryStore;
							const encoder = primaryStore.encoder;
							if (auditRecord.extendedType & HAS_STRUCTURE_UPDATE || !encoder.typedStructs) {
								// there is a structure update, we need to reload the structure from storage.
								// this is copied from msgpackr's struct, may want to expose as public method
								encoder._mergeStructures(encoder.getStructures());
								if (encoder.typedStructs) encoder.lastTypedStructuresLength = encoder.typedStructs.length;
							}
							const timeRange = subscribedNodeIds[nodeId];
							const isWithinSubscriptionRange =
								timeRange && timeRange.startTime < localTime && (!timeRange.endTime || timeRange.endTime > localTime);
							if (!isWithinSubscriptionRange) {
								if (DEBUG_MODE)
									logger.trace?.(
										connectionId,
										'skipping replication update',
										auditRecord.recordId,
										'to:',
										remoteNodeName,
										'from:',
										nodeId,
										'subscribed:',
										subscribedNodeIds
									);
								// we are skipping this message because it is being sent from another node, but we still want to
								// occasionally send a sequence update so that if we reconnect we don't have to go back to far in the
								// audit log
								return skipAuditRecord();
							}
							if (DEBUG_MODE)
								logger.trace?.(
									connectionId,
									'sending replication update',
									auditRecord.recordId,
									'to:',
									remoteNodeName,
									'from:',
									nodeId,
									'subscribed:',
									subscribedNodeIds
								);
							const txnTime = auditRecord.version;
							if (currentTransaction.txnTime !== txnTime) {
								// send the queued transaction
								if (currentTransaction.txnTime) {
									if (DEBUG_MODE)
										logger.trace?.(connectionId, 'new txn time, sending queued txn', currentTransaction.txnTime);
									if (encodingBuffer[encodingStart] !== 66) {
										logger.error?.('Invalid encoding of message');
									}
									sendQueuedData();
								}
								currentTransaction.txnTime = txnTime;
								encodingStart = position;
								writeFloat64(txnTime);
							}

							const residencyId = auditRecord.residencyId;
							const residency = getResidence(residencyId, table);
							let invalidationEntry;
							if (residency && !residency.includes(remoteNodeName)) {
								// If this node won't have residency, we need to send out invalidation messages
								const previousResidency = getResidence(auditRecord.previousResidencyId, table);
								if (
									(previousResidency &&
										!previousResidency.includes(remoteNodeName) &&
										(auditRecord.type === 'put' || auditRecord.type === 'patch')) ||
									table.getResidencyById
								) {
									// if we were already omitted from the previous residency, we don't need to send out invalidation messages for record updates
									// or if we are using residency by id, this means we don't even need any data sent to other servers
									return skipAuditRecord();
								}
								const recordId = auditRecord.recordId;
								// send out invalidation messages
								logger.trace?.(connectionId, 'sending invalidation', recordId, remoteNodeName, 'from', nodeId);
								let extendedType = 0;
								if (residencyId) extendedType |= HAS_CURRENT_RESIDENCY_ID;
								if (auditRecord.previousResidencyId) extendedType |= HAS_PREVIOUS_RESIDENCY_ID;
								let fullRecord: any,
									partialRecord = null;
								for (const name in table.indices) {
									if (!partialRecord) {
										fullRecord = auditRecord.getValue(primaryStore, true);
										if (!fullRecord) break; // if there is no record, as is the case with a relocate, we can't send it
										partialRecord = {};
									}
									// if there are any indices, we need to preserve a partial invalidated record to ensure we can still do searches
									partialRecord[name] = fullRecord[name];
								}

								invalidationEntry = createAuditEntry(
									auditRecord.version,
									tableId,
									recordId,
									null,
									nodeId,
									auditRecord.user,
									auditRecord.type === 'put' || auditRecord.type === 'patch' ? 'invalidate' : auditRecord.type,
									encoder.encode(partialRecord), // use the store's encoder; note that this may actually result in a new structure being created
									extendedType,
									residencyId,
									auditRecord.previousResidencyId,
									auditRecord.expiresAt
								);
								// entry is encoded, send it after checks for new structure and residency
							}

							// when we can skip an audit record, we still need to occasionally send a sequence update:
							function skipAuditRecord() {
								logger.trace?.(connectionId, 'skipping audit record', auditRecord.recordId);
								if (!skippedMessageSequenceUpdateTimer) {
									skippedMessageSequenceUpdateTimer = setTimeout(() => {
										skippedMessageSequenceUpdateTimer = null;
										// check to see if we are too far behind, but if so, send a sequence update
										if ((sentSequenceId || 0) + SKIPPED_MESSAGE_SEQUENCE_UPDATE_DELAY / 2 < currentSequenceId) {
											if (DEBUG_MODE)
												logger.trace?.(connectionId, 'sending skipped sequence update', currentSequenceId);
											ws.send(encode([SEQUENCE_ID_UPDATE, currentSequenceId]));
										}
									}, SKIPPED_MESSAGE_SEQUENCE_UPDATE_DELAY).unref();
								}
								return new Promise(setImmediate); // we still need to yield (otherwise we might never send a sequence id update)
							}

							const typedStructs = encoder.typedStructs;
							const structures = encoder.structures;
							if (
								typedStructs?.length != tableEntry.typed_length ||
								structures?.length != tableEntry.structure_length
							) {
								tableEntry.typed_length = typedStructs?.length;
								tableEntry.structure_length = structures.length;
								// the structure used for encoding records has changed, so we need to send the new structure
								logger.debug?.(connectionId, 'send table struct', tableEntry.typed_length, tableEntry.structure_length);
								if (!tableEntry.sentName) {
									tableEntry.sentName = true;
								}
								ws.send(
									encode([
										TABLE_FIXED_STRUCTURE,
										{
											typedStructs,
											structures,
											attributes: table.attributes,
											schemaDefined: table.schemaDefined,
										},
										tableId,
										tableEntry.table.tableName,
									])
								);
							}
							if (residencyId && !sentResidencyLists[residencyId]) {
								ws.send(encode([RESIDENCY_LIST, residency, residencyId]));
								sentResidencyLists[residencyId] = true;
							}
							/*
							TODO: At some point we may want some fancier logic to elide the version (which is the same as txnTime)
							and username from subsequent audit entries in multiple entry transactions*/
							if (invalidationEntry) {
								// if we have an invalidation entry to send, do that now
								writeInt(invalidationEntry.length);
								writeBytes(invalidationEntry);
							} else {
								// directly write the audit record.
								const encoded = auditRecord.encoded;
								if (auditRecord.extendedType & HAS_BLOBS) {
									// if there are blobs, we need to find them and send their contents
									decodeWithBlobCallback(() => auditRecord.getValue(primaryStore), sendBlobs, primaryStore.rootStore);
								}
								// If it starts with the previous local time, we omit that
								const start = encoded[0] === 66 ? 8 : 0;
								writeInt(encoded.length - start);
								writeBytes(encoded, start);
								logger.trace?.('wrote record', auditRecord.recordId, 'length:', encoded.length);
							}
							// wait if there is back-pressure
							if (ws._socket.writableNeedDrain) {
								return new Promise<void>((resolve) => {
									logger.debug?.(
										`Waiting for remote node ${remoteNodeName} to allow more commits ${ws._socket.writableNeedDrain ? 'due to network backlog' : 'due to requested flow directive'}`
									);
									ws._socket.once('drain', resolve);
								});
							} else if (outstandingBlobsBeingSent > MAX_OUTSTANDING_BLOBS_BEING_SENT) {
								return new Promise((resolve) => {
									blobSentCallback = resolve;
								});
							} else return new Promise(setImmediate); // yield on each turn for fairness and letting other things run
						};
						const sendQueuedData = () => {
							if (position - encodingStart > 8) {
								// if we have more than just a txn time, send it
								ws.send(encodingBuffer.subarray(encodingStart, position));
								logger.debug?.(connectionId, 'Sent message, size:', position - encodingStart);
								recordAction(
									position - encodingStart,
									'bytes-sent',
									`${remoteNodeName}.${databaseName}`,
									'replication',
									'egress'
								);
							} else logger.debug?.(connectionId, 'skipping empty transaction');
						};

						auditSubscription = new EventEmitter();
						auditSubscription.once('close', () => {
							closed = true;
							subscriptionToHdbNodes?.end();
						});
						// find the earliest start time of the subscriptions
						for (const { startTime } of nodeSubscriptions) {
							if (startTime < currentSequenceId) currentSequenceId = startTime;
						}
						// wait for internal subscription, might be waiting for a table to be registered
						(whenSubscribedToHdbNodes || Promise.resolve())
							.then(async () => {
								tableSubscriptionToReplicator = await tableSubscriptionToReplicator;
								auditStore = tableSubscriptionToReplicator.auditStore;
								tableById = tableSubscriptionToReplicator.tableById.map(tableToTableEntry);
								subscribedNodeIds = [];
								for (const { name, startTime, endTime } of nodeSubscriptions) {
									const localId = getIdOfRemoteNode(name, auditStore);
									logger.debug?.('subscription to', name, 'using local id', localId, 'starting', startTime);
									subscribedNodeIds[localId] = { startTime, endTime };
								}

								sendDBSchema(databaseName);
								if (!schemaUpdateListener) {
									schemaUpdateListener = onUpdatedTable((table) => {
										if (table.databaseName === databaseName) {
											sendDBSchema(databaseName);
										}
									});
									dbRemovalListener = onRemovedDB((db) => {
										// I guess if a database is removed then we disconnect. This is kind of weird situation for replication,
										// as the replication system will try to preserve consistency between nodes and their databases, and
										// it is unclear what to do if a database is removed and what that means for consistency seekingd
										if (db === databaseName) {
											ws.send(encode([DISCONNECT]));
											close();
										}
									});
									ws.on('close', () => {
										schemaUpdateListener?.remove();
										dbRemovalListener?.remove();
									});
								}
								// Send a message to the remote node with the node id mapping, indicating how each node name is mapped to a short id
								// and a list of the node names that are subscribed to this node
								ws.send(
									encode([
										NODE_NAME_TO_ID_MAP,
										exportIdMapping(tableSubscriptionToReplicator.auditStore),
										nodeSubscriptions.map(({ name }) => name),
									])
								);

								let isFirst = true;
								do {
									// We run subscriptions as a loop where retrieve entries from the audit log, since the last entry
									// and sending out the results while applying back-pressure from the socket. When we are out of entries
									// then we switch to waiting/listening for the next transaction notifications before resuming the iteration
									// through the audit log.
									if (!isFinite(currentSequenceId)) {
										logger.warn?.('Invalid sequence id ' + currentSequenceId);
										close(1008, 'Invalid sequence id' + currentSequenceId);
									}
									let queuedEntries;
									if (isFirst && !closed) {
										isFirst = false;
										if (currentSequenceId === 0) {
											logger.info?.('Replicating all tables to', remoteNodeName);
											let lastSequenceId = currentSequenceId;
											const nodeId = getThisNodeId(auditStore);
											for (const tableName in tables) {
												if (!tableToTableEntry(tableName)) continue; // if we aren't replicating this table, skip it
												const table = tables[tableName];
												for (const entry of table.primaryStore.getRange({
													snapshot: false,
													versions: true,
													// values: false, // TODO: eventually, we don't want to decode, we want to use fast binary transfer
												})) {
													if (closed) return;
													if (entry.localTime >= currentSequenceId) {
														logger.trace?.(
															connectionId,
															'Copying record from',
															databaseName,
															tableName,
															entry.key,
															entry.localTime
														);
														lastSequenceId = Math.max(entry.localTime, lastSequenceId);
														queuedEntries = true;
														getSharedStatus()[SENDING_TIME_POSITION] = 1;
														const encoded = createAuditEntry(
															entry.version,
															table.tableId,
															entry.key,
															null,
															nodeId,
															null,
															'put',
															decodeWithBlobCallback(() => table.primaryStore.encoder.encode(entry.value), sendBlobs),
															entry.metadataFlags & ~0xff, // exclude the lower bits that define the type
															entry.residencyId,
															null,
															entry.expiresAt
														);
														await sendAuditRecord(
															{
																// make it look like an audit record
																recordId: entry.key,
																tableId: table.tableId,
																type: 'put',
																getValue() {
																	return entry.value;
																},
																encoded,
																version: entry.version,
																residencyId: entry.residencyId,
																nodeId,
																extendedType: entry.metadataFlags,
															},
															entry.localTime
														);
													}
												}
											}
											if (queuedEntries)
												sendAuditRecord(
													{
														type: 'end_txn',
													},
													currentSequenceId
												);
											getSharedStatus()[SENDING_TIME_POSITION] = 0;
											currentSequenceId = lastSequenceId;
										}
									}
									for (const { key, value: auditEntry } of auditStore.getRange({
										start: currentSequenceId || 1,
										exclusiveStart: true,
										snapshot: false, // don't want to use a snapshot, and we want to see new entries
									})) {
										if (closed) return;
										const auditRecord = readAuditEntry(auditEntry);
										logger.debug?.('sending audit record', new Date(key));
										getSharedStatus()[SENDING_TIME_POSITION] = key;
										currentSequenceId = key;
										await sendAuditRecord(auditRecord, key);
										auditSubscription.startTime = key; // update so don't double send
										queuedEntries = true;
									}
									if (queuedEntries)
										sendAuditRecord(
											{
												type: 'end_txn',
											},
											currentSequenceId
										);
									getSharedStatus()[SENDING_TIME_POSITION] = 0;
									await whenNextTransaction(auditStore);
								} while (!closed);
							})
							.catch((error) => {
								logger.error?.(connectionId, 'Error handling subscription to node', error);
								close(1008, 'Error handling subscription to node');
							});
						break;
					}
				}
				return;
			}

			/* If we are past the commands, we are now handling an incoming replication message, the next block
			 * handles parsing and transacting these replication messages */
			decoder.position = 8;
			let beginTxn = true;
			let event; // could also get txnTime from decoder.getFloat64(0);
			let sequenceIdReceived;
			do {
				getSharedStatus();
				const eventLength = decoder.readInt();
				if (eventLength === 9 && decoder.getUint8(decoder.position) == REMOTE_SEQUENCE_UPDATE) {
					decoder.position++;
					lastSequenceIdReceived = sequenceIdReceived = decoder.readFloat64();
					replicationSharedStatus[RECEIVED_VERSION_POSITION] = lastSequenceIdReceived;
					replicationSharedStatus[RECEIVED_TIME_POSITION] = Date.now();
					replicationSharedStatus[RECEIVING_STATUS_POSITION] = RECEIVING_STATUS_WAITING;
					logger.trace?.('received remote sequence update', lastSequenceIdReceived, databaseName);
					break;
				}
				const start = decoder.position;
				const auditRecord = readAuditEntry(body, start, start + eventLength);
				const tableDecoder = tableDecoders[auditRecord.tableId];
				if (!tableDecoder) {
					logger.error?.(`No table found with an id of ${auditRecord.tableId}`);
				}
				let residencyList;
				if (auditRecord.residencyId) {
					residencyList = receivedResidencyLists[auditRecord.residencyId];
					logger.trace?.(
						connectionId,
						'received residency list',
						residencyList,
						auditRecord.type,
						auditRecord.recordId
					);
				}
				try {
					const id = auditRecord.recordId;
					decodeBlobsWithWrites(
						() => {
							event = {
								table: tableDecoder.name,
								id: auditRecord.recordId,
								type: auditRecord.type,
								nodeId: remoteShortIdToLocalId.get(auditRecord.nodeId),
								residencyList,
								timestamp: auditRecord.version,
								value: auditRecord.getValue(tableDecoder),
								user: auditRecord.user,
								beginTxn,
								expiresAt: auditRecord.expiresAt,
							};
						},
						(blob) => receiveBlobs(blob, id)
					);
				} catch (error) {
					error.message += 'typed structures for current decoder' + JSON.stringify(tableDecoder.decoder.typedStructs);
					throw error;
				}
				beginTxn = false;
				// TODO: Once it is committed, also record the localtime in the table with symbol metadata, so we can resume from that point
				logger.trace?.(
					connectionId,
					'received replication message',
					auditRecord.type,
					'id',
					event.id,
					'version',
					new Date(auditRecord.version),
					'nodeId',
					event.nodeId
				);
				replicationSharedStatus[RECEIVED_VERSION_POSITION] = auditRecord.version;
				replicationSharedStatus[RECEIVED_TIME_POSITION] = Date.now();
				replicationSharedStatus[RECEIVING_STATUS_POSITION] = RECEIVING_STATUS_RECEIVING;

				tableSubscriptionToReplicator.send(event);
				decoder.position = start + eventLength;
			} while (decoder.position < body.byteLength);
			outstandingCommits++;
			recordAction(
				body.byteLength,
				'bytes-received',
				`${remoteNodeName}.${databaseName}.${event?.table || 'unknown_table'}`,
				'replication',
				'ingest'
			);
			if (outstandingCommits > MAX_OUTSTANDING_COMMITS && !replicationPaused) {
				replicationPaused = true;
				ws.pause();
				logger.debug?.(
					`Commit backlog causing replication back-pressure, requesting that ${remoteNodeName} pause replication`
				);
			}
			tableSubscriptionToReplicator.send({
				type: 'end_txn',
				localTime: lastSequenceIdReceived,
				remoteNodeIds: receivingDataFromNodeIds,
				async onCommit() {
					if (event) {
						const latency = Date.now() - event.timestamp;
						recordAction(
							latency,
							'replication-latency',
							remoteNodeName + '.' + databaseName + '.' + event.table,
							event.type,
							'ingest'
						);
					}
					outstandingCommits--;
					if (replicationPaused) {
						replicationPaused = false;
						ws.resume();
						logger.debug?.(`Replication resuming ${remoteNodeName}`);
					}
					// if there are outstanding blobs to finish writing, delay commit receipts until they are finished (so that if we are interrupting
					// we correctly resend the blobs)
					if (outstandingBlobsToFinish.length > 0) await Promise.all(outstandingBlobsToFinish);
					logger.trace?.('All blobs finished');
					if (!lastSequenceIdCommitted && sequenceIdReceived) {
						logger.trace?.(connectionId, 'queuing confirmation of a commit at', sequenceIdReceived);
						setTimeout(() => {
							ws.send(encode([COMMITTED_UPDATE, lastSequenceIdCommitted]));
							logger.trace?.(connectionId, 'sent confirmation of a commit at', lastSequenceIdCommitted);
							lastSequenceIdCommitted = null;
						}, COMMITTED_UPDATE_DELAY);
					}
					lastSequenceIdCommitted = sequenceIdReceived;
					logger.debug?.('last sequence committed', new Date(sequenceIdReceived), databaseName);
				},
			});
		} catch (error) {
			logger.error?.(connectionId, 'Error handling incoming replication message', error);
		}
	});
	ws.on('ping', resetPingTimer);
	ws.on('pong', () => {
		if (options.connection) {
			// every pong we can use to update our connection information (and latency)
			const latency = performance.now() - lastPingTime;
			options.connection.latency = latency;
			if (getSharedStatus()) {
				replicationSharedStatus[LATENCY_POSITION] = latency;
			}
			// update the manager with latest connection information
			if (options.isSubscriptionConnection) {
				connectedToNode({
					name: remoteNodeName,
					database: databaseName,
					url: options.url,
					latency,
				});
			}
		}
		lastPingTime = null;
	});
	ws.on('close', (code, reasonBuffer) => {
		// cleanup
		clearInterval(sendPingInterval);
		clearTimeout(receivePingTimer);
		clearInterval(blobsTimer);
		if (auditSubscription) auditSubscription.emit('close');
		if (subscriptionRequest) subscriptionRequest.end();
		for (const [id, { reject }] of awaitingResponse) {
			reject(new Error(`Connection closed ${reasonBuffer?.toString()} ${code}`));
		}
		logger.debug?.(connectionId, 'closed', code, reasonBuffer?.toString());
	});

	function close(code?, reason?) {
		try {
			ws.isFinished = true;
			logger.debug?.(connectionId, 'closing', remoteNodeName, databaseName, code, reason);
			ws.close(code, reason);
			options.connection?.emit('finished'); // we want to synchronously indicate that the connection is finished, so it is not accidently reused
		} catch (error) {
			logger.error?.(connectionId, 'Error closing connection', error);
		}
	}
	// Track the blobs being sent, so we can wait for them to finish before sending the next blob.
	// The same blobs can't be sent concurrently of the packets will get mixed up. The receiving
	// end should handle aggregated the results of the same blob for separate record requests.
	const blobsBeingSent = new Set();
	async function sendBlobs(blob) {
		// found a blob, start sending it
		const id = getFileId(blob);
		if (blobsBeingSent.has(id)) {
			logger.debug?.('Blob already being sent', id);
			return;
		}
		blobsBeingSent.add(id);
		try {
			let lastBuffer: Buffer;
			outstandingBlobsBeingSent++;
			for await (const buffer of blob.stream()) {
				if (lastBuffer) {
					logger.debug?.('Sending blob chunk', id, 'length', lastBuffer.length);
					// do the previous buffer so we know if it is the last one or not
					ws.send(
						encode([
							BLOB_CHUNK,
							{
								fileId: id,
								size: blob.size,
							},
							lastBuffer,
						])
					);
				}
				lastBuffer = buffer;
				if (ws._socket.writableNeedDrain) {
					logger.debug?.('draining', id);
					await new Promise((resolve) => ws._socket.once('drain', resolve));
					logger.debug?.('drained', id);
				}
				recordAction(buffer.length, 'bytes-sent', `${remoteNodeName}.${databaseName}`, 'replication', 'blob');
			}
			logger.debug?.('Sending final blob chunk', id, 'length', lastBuffer.length);
			ws.send(
				encode([
					BLOB_CHUNK,
					{
						fileId: id,
						size: blob.size,
						finished: true,
					},
					lastBuffer,
				])
			);
		} catch (error) {
			logger.debug?.('Error sending blob', error);
			ws.send(
				encode([
					BLOB_CHUNK,
					{
						fileId: id,
						finished: true,
						error: errorToString(error),
					},
					Buffer.alloc(0),
				])
			);
		} finally {
			blobsBeingSent.delete(id);
			outstandingBlobsBeingSent--;
			if (outstandingBlobsBeingSent < MAX_OUTSTANDING_BLOBS_BEING_SENT) blobSentCallback?.();
		}
	}
	function receiveBlobs(remoteBlob: Blob, id: string | number) {
		// write the blob to the blob store
		const blobId = getFileId(remoteBlob);
		let stream = blobsInFlight.get(blobId);
		logger.debug?.('Received transaction with blob', blobId, 'has stream', !!stream, 'ended', !!stream?.writableEnded);
		if (stream) {
			if (stream.writableEnded) {
				blobsInFlight.delete(blobId);
			}
		} else {
			stream = new PassThrough();
			blobsInFlight.set(blobId, stream);
		}
		stream.connectedToBlob = true;
		stream.lastChunk = Date.now();
		stream.recordId = id;
		if (remoteBlob.size === undefined && stream.expectedSize) remoteBlob.size = stream.expectedSize;
		const localBlob = stream.blob ?? createBlob(stream, remoteBlob);
		stream.blob = localBlob; // record the blob so we can reuse it if another request uses the same blob

		// start the save immediately
		const finished = localBlob.save({
			// need to pass in the table, but this is table-like enough for it to get the root store
			primaryStore: tableSubscriptionToReplicator.auditStore,
		});
		if (finished) {
			finished.blobId = blobId;
			outstandingBlobsToFinish.push(finished);
			finished.finally(() => {
				logger.debug?.(`Finished receiving blob stream ${blobId}`);
				outstandingBlobsToFinish.splice(outstandingBlobsToFinish.indexOf(finished), 1);
			});
		}
		return localBlob;
	}
	function sendSubscriptionRequestUpdate() {
		// once we have received the node name, and we know the database name that this connection is for,
		// we can send a subscription request, if no other threads have subscribed.
		if (!subscribed) {
			subscribed = true;
			options.connection?.on('subscriptions-updated', sendSubscriptionRequestUpdate);
		}
		if (!auditStore && tableSubscriptionToReplicator) auditStore = tableSubscriptionToReplicator.auditStore;
		if (options.connection?.isFinished)
			throw new Error('Can not make a subscription request on a connection that is already closed');
		const lastTxnTimes = new Map();
		if (!auditStore)
			// if it hasn't been set yet, do so now
			auditStore = tableSubscriptionToReplicator?.auditStore;
		// iterate through all the sequence entries and find the newest txn time for each node
		try {
			for (const entry of tableSubscriptionToReplicator?.dbisDB?.getRange({
				start: Symbol.for('seq'),
				end: [Symbol.for('seq'), Buffer.from([0xff])],
			}) || []) {
				for (const node of entry.value.nodes || []) {
					if (node.lastTxnTime > (lastTxnTimes.get(node.id) ?? 0)) lastTxnTimes.set(node.id, node.lastTxnTime);
				}
			}
		} catch (error) {
			// if the database is closed, just proceed (matches multiple error messages)
			if (!error.message.includes('Can not re')) throw error;
		}
		const connectedNode = options.connection?.nodeSubscriptions?.[0];
		receivingDataFromNodeIds = [];
		const nodeSubscriptions = options.connection?.nodeSubscriptions.map((node: any, index: number) => {
			const tableSubs = [];
			let { replicateByDefault: replicateByDefault } = node;
			if (node.subscriptions) {
				// if the node has explicit subscriptions, we need to use that to determine subscriptions
				for (const subscription of node.subscriptions) {
					// if there is an explicit subscription listed
					if (subscription.subscribe && (subscription.schema || subscription.database) === databaseName) {
						const tableName = subscription.table;
						if (tables?.[tableName]?.replicate !== false)
							// if replication is enabled for this table
							tableSubs.push(tableName);
					}
				}
				replicateByDefault = false; // now turn off the default replication because it was an explicit list of subscriptions
			} else {
				// note that if replicateByDefault is enabled, we are listing the *excluded* tables
				for (const tableName in tables) {
					if (replicateByDefault ? tables[tableName].replicate === false : tables[tableName].replicate) {
						tableSubs.push(tableName);
					}
				}
			}

			const nodeId = auditStore && getIdOfRemoteNode(node.name, auditStore);
			const sequenceEntry = tableSubscriptionToReplicator?.dbisDB?.get([Symbol.for('seq'), nodeId]) ?? 1;
			// if we are connected directly to the node, we start from the last sequence number we received at the top level
			let startTime = Math.max(
				sequenceEntry?.seqId ?? 1,
				(typeof node.startTime === 'string' ? new Date(node.startTime).getTime() : node.startTime) ?? 1
			);
			logger.debug?.(
				'Starting time recorded in db',
				node.name,
				nodeId,
				databaseName,
				sequenceEntry?.seqId,
				'start time:',
				startTime,
				new Date(startTime)
			);
			if (connectedNode !== node) {
				// indirect connection through a proxying node
				// if there is a last sequence id we received through the proxying node that is newer, we can start from there
				const connectedNodeId = auditStore && getIdOfRemoteNode(connectedNode.name, auditStore);
				const sequenceEntry = tableSubscriptionToReplicator?.dbisDB?.get([Symbol.for('seq'), connectedNodeId]) ?? 1;
				for (const seqNode of sequenceEntry?.nodes || []) {
					if (seqNode.name === node.name) {
						startTime = seqNode.seqId;
						logger.debug?.('Using sequence id from proxy node', connectedNode.name, startTime);
					}
				}
			}
			if (nodeId === undefined) {
				logger.warn('Starting subscription request from node', node, 'but no node id found');
			} else receivingDataFromNodeIds.push(nodeId);
			// if another node had previously acted as a proxy, it may not have the same sequence ids, but we can use the last
			// originating txn time, and sequence ids should always be higher than their originating txn time, and starting from them should overlap
			if (lastTxnTimes.get(nodeId) > startTime) {
				startTime = lastTxnTimes.get(nodeId);
				logger.debug?.('Updating start time from more recent txn recorded', connectedNode.name, startTime);
			}
			if (startTime === 1 && leaderUrl) {
				// if we are starting from scratch and we have a leader URL, we directly ask for a copy from that database
				try {
					if (new URL(leaderUrl).hostname === node.name) {
						logger.warn?.(`Requesting full copy of database ${databaseName} from ${leaderUrl}`);
						startTime = 0; // use this to indicate that we want to fully copy
					} else {
						// for all other nodes, start at right now (minus a minute for overlap)
						startTime = Date.now() - 60000;
					}
				} catch (error) {
					logger.error?.('Error parsing leader URL', leaderUrl, error);
				}
			}
			logger.trace?.(connectionId, 'defining subscription request', node.name, databaseName, new Date(startTime));
			return {
				name: node.name,
				replicateByDefault,
				tables: tableSubs, // omitted or included based on flag above
				startTime,
				endTime: node.endTime,
			};
		});

		if (nodeSubscriptions) {
			logger.debug?.(
				connectionId,
				'sending subscription request',
				nodeSubscriptions,
				tableSubscriptionToReplicator?.dbisDB?.path
			);
			clearTimeout(delayedClose);
			if (nodeSubscriptions.length > 0) ws.send(encode([SUBSCRIPTION_REQUEST, nodeSubscriptions]));
			else {
				// no nodes means we are unsubscribing/disconnecting
				// don't immediately close the connection, but wait a bit to see if we get any messages, since opening new connections is a bit expensive
				const scheduleClose = () => {
					const scheduled = performance.now();
					delayedClose = setTimeout(() => {
						// if we have not received any messages in a while, we can close the connection
						if (lastMessageTime <= scheduled) close(1008, 'Connection has no subscriptions and is no longer used');
						else scheduleClose();
					}, DELAY_CLOSE_TIME).unref();
				};
				scheduleClose();
			}
		}
	}

	function getResidence(residencyId, table) {
		if (!residencyId) return;
		let residency = residencyMap[residencyId];
		if (!residency) {
			residency = table.getResidencyRecord(residencyId);
			residencyMap[residencyId] = residency;
			// TODO: Send the residency record
		}
		return residency;
	}

	function checkDatabaseAccess(databaseName: string) {
		if (
			enabledDatabases &&
			enabledDatabases != '*' &&
			!enabledDatabases[databaseName] &&
			!enabledDatabases.includes?.(databaseName) &&
			!enabledDatabases.some?.((dbConfig) => dbConfig.name === databaseName)
		) {
			// TODO: Check the authorization as well
			return false;
		}
		return true;
	}
	function setDatabase(databaseName) {
		tableSubscriptionToReplicator = tableSubscriptionToReplicator || dbSubscriptions.get(databaseName);
		if (!checkDatabaseAccess(databaseName)) {
			throw new Error(`Access to database "${databaseName}" is not permitted`);
		}
		if (!tableSubscriptionToReplicator) {
			logger.warn?.(`No database named "${databaseName}" was declared and registered`);
		}
		auditStore = tableSubscriptionToReplicator?.auditStore;
		if (!tables) tables = getDatabases()?.[databaseName];

		const thisNodeName = getThisNodeName();
		if (thisNodeName === remoteNodeName) {
			if (!thisNodeName) throw new Error('Node name not defined');
			else throw new Error('Should not connect to self', thisNodeName);
		}
		sendNodeDBName(thisNodeName, databaseName);
		return true;
	}
	function sendNodeDBName(thisNodeName, databaseName) {
		const database = getDatabases()?.[databaseName];
		const tables = [];
		for (const tableName in database) {
			const table = database[tableName];
			tables.push({
				table: tableName,
				schemaDefined: table.schemaDefined,
				attributes: table.attributes.map((attr) => ({
					name: attr.name,
					type: attr.type,
					isPrimaryKey: attr.isPrimaryKey,
				})),
			});
		}
		logger.trace?.('Sending database info for node', thisNodeName, 'database name', databaseName);
		ws.send(encode([NODE_NAME, thisNodeName, databaseName, tables]));
	}
	function sendDBSchema(databaseName) {
		const database = getDatabases()?.[databaseName];
		const tables = [];
		for (const tableName in database) {
			if (
				nodeSubscriptions &&
				!nodeSubscriptions.some((node) => {
					return node.replicateByDefault ? !node.tables.includes(tableName) : node.tables.includes(tableName);
				})
			)
				continue;
			const table = database[tableName];
			tables.push({
				table: tableName,
				schemaDefined: table.schemaDefined,
				attributes: table.attributes.map((attr) => ({
					name: attr.name,
					type: attr.type,
					isPrimaryKey: attr.isPrimaryKey,
				})),
			});
		}

		ws.send(encode([DB_SCHEMA, tables, databaseName]));
	}
	blobsTimer = setInterval(() => {
		for (const [blobId, stream] of blobsInFlight) {
			if (stream.lastChunk + blobTimeout < Date.now()) {
				logger.warn?.(
					`Timeout waiting for blob stream to finish ${blobId} for record ${stream.recordId ?? 'unknown'} from ${remoteNodeName}`
				);
				blobsInFlight.delete(blobId);
				stream.end();
			}
		}
	}, blobTimeout).unref();

	let nextId = 1;
	const sentTableNames = [];
	return {
		end() {
			// cleanup
			if (subscriptionRequest) subscriptionRequest.end();
			if (auditSubscription) auditSubscription.emit('close');
		},
		getRecord(request) {
			// send a request for a specific record
			const requestId = nextId++;
			return new Promise((resolve, reject) => {
				const message = [GET_RECORD, requestId, request.table.tableId, request.id];
				if (!sentTableNames[request.table.tableId]) {
					message.push(request.table.tableName);
					sentTableNames[request.table.tableId] = true;
				}
				ws.send(encode(message));
				lastMessageTime = performance.now();
				awaitingResponse.set(requestId, {
					tableId: request.table.tableId,
					key: request.id,
					resolve(entry) {
						const { table, entry: existingEntry } = request;
						// we can immediately resolve this because the data is available.
						resolve(entry);
						// However, if we are going to record this locally, we need to record it as a relocation event
						// and determine new residency information
						if (entry) return table._recordRelocate(existingEntry, entry);
					},
					reject,
				});
			});
		},
		/**
		 * Send an operation request to the remote node, returning a promise for the result
		 * @param operation
		 */
		sendOperation(operation) {
			const requestId = nextId++;
			operation.requestId = requestId;
			ws.send(encode([OPERATION_REQUEST, operation]));
			return new Promise((resolve, reject) => {
				awaitingResponse.set(requestId, { resolve, reject });
			});
		},
	};

	// write an integer to the current buffer
	function writeInt(number) {
		checkRoom(5);
		if (number < 128) {
			encodingBuffer[position++] = number;
		} else if (number < 0x4000) {
			dataView.setUint16(position, number | 0x8000);
			position += 2;
		} else if (number < 0x3f000000) {
			dataView.setUint32(position, number | 0xc0000000);
			position += 4;
		} else {
			encodingBuffer[position] = 0xff;
			dataView.setUint32(position + 1, number);
			position += 5;
		}
	}

	// write raw binary/bytes to the current buffer
	function writeBytes(src, start = 0, end = src.length) {
		const length = end - start;
		checkRoom(length);
		src.copy(encodingBuffer, position, start, end);
		position += length;
	}

	function writeFloat64(number) {
		checkRoom(8);
		dataView.setFloat64(position, number);
		position += 8;
	}
	function checkRoom(length) {
		if (length + 16 > encodingBuffer.length - position) {
			const newBuffer = Buffer.allocUnsafeSlow(((position + length - encodingStart + 0x10000) >> 10) << 11);
			encodingBuffer.copy(newBuffer, 0, encodingStart, position);
			position = position - encodingStart;
			encodingStart = 0;
			encodingBuffer = newBuffer;
			dataView = new DataView(encodingBuffer.buffer, 0, encodingBuffer.length);
		}
	}
	// Check the attributes in the msg vs the table and if they dont match call ensureTable to create them
	function ensureTableIfChanged(tableDefinition: any, existingTable: any) {
		const dbName = tableDefinition.database ?? 'data';
		if (dbName !== 'data' && !databases[dbName]) {
			logger.warn?.('Database not found', tableDefinition.database);
			return;
		}
		if (!existingTable) existingTable = {};
		const wasSchemaDefined = existingTable.schemaDefined;
		let hasChanges = false;
		const schemaDefined = tableDefinition.schemaDefined;
		const attributes = existingTable.attributes || [];
		for (let i = 0; i < tableDefinition.attributes?.length; i++) {
			const ensureAttribute = tableDefinition.attributes[i];
			const existingAttribute = attributes.find((attr) => attr.name === ensureAttribute.name);
			if (!existingAttribute || existingAttribute.type !== ensureAttribute.type) {
				// a difference in the attribute definitions was found
				if (wasSchemaDefined) {
					// if the schema is defined, we will not change, we will honor our local definition, as it is just going to cause a battle between nodes if there are differences that we try to propagate
					logger.error?.(
						`Schema for '${databaseName}.${tableDefinition.table}' is defined locally, but attribute '${ensureAttribute.name}: ${ensureAttribute.type}' from '${
							remoteNodeName
						}' does not match local attribute ${existingAttribute ? "'" + existingAttribute.name + ': ' + existingAttribute.type + "'" : 'which does not exist'}`
					);
				} else {
					hasChanges = true;
					if (!schemaDefined) ensureAttribute.indexed = true; // if it is a dynamic schema, we need to index (all) the attributes
					if (existingAttribute) attributes[attributes.indexOf(existingAttribute)] = ensureAttribute;
					else attributes.push(ensureAttribute);
				}
			}
		}
		if (hasChanges) {
			logger.debug?.('(Re)creating', tableDefinition);
			return ensureTable({
				table: tableDefinition.table,
				database: tableDefinition.database,
				schemaDefined: tableDefinition.schemaDefined,
				attributes,
				...existingTable,
			});
		}
		return existingTable;
	}
}

class Encoder {
	constructor() {}
}
