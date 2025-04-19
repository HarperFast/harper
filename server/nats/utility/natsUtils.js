'use strict';

const envManager = require('../../../utility/environment/environmentManager.js');
envManager.initSync();

const fs = require('fs-extra');
const semver = require('semver');
const path = require('path');
const { monotonicFactory } = require('ulidx');
const ulid = monotonicFactory();
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const spawn = childProcess.spawn;
const natsTerms = require('./natsTerms.js');
const hdbTerms = require('../../../utility/hdbTerms.ts');
const { packageJson, PACKAGE_ROOT } = require('../../../utility/packageUtils.js');
const hdbUtils = require('../../../utility/common_utils.js');
const hdbLogger = require('../../../utility/logging/harper_logger.js');
const cryptoHash = require('../../../security/cryptoHash.js');
const transaction = require('../../../dataLayer/transaction.js');
const configUtils = require('../../../config/configUtils.js');
const { broadcast, onMessageByType, getWorkerIndex } = require('../../threads/manageThreads.js');
const { isMainThread } = require('worker_threads');
const { Encoder, decode } = require('msgpackr');
const encoder = new Encoder(); // use default encoder options

const { isEmpty } = hdbUtils;
const user = require('../../../security/user.js');

const INGEST_MAX_MSG_AGE = 48 * 3600000000000; // nanoseconds
const INGEST_MAX_BYTES = 5000000000;
const MAX_INGEST_THREADS = 2; // This can also be set in harperdb-config

// Max delay between attempts to connect to remote node
const MAX_REMOTE_CON_RETRY_DELAY = 10000;

if (isMainThread) {
	onMessageByType(hdbTerms.ITC_EVENT_TYPES.RESTART, () => {
		natsConnection = undefined;
		natsConnectionPromise = undefined;
	});
}

const {
	connect,
	StorageType,
	RetentionPolicy,
	AckPolicy,
	DeliverPolicy,
	DiscardPolicy,
	NatsConnection,
	JetStreamManager,
	JetStreamClient,
	StringCodec,
	JSONCodec,
	createInbox,
	headers,
	ErrorCode,
} = require('nats');

const { recordAction } = require('../../../resources/analytics/write.ts');
const { encodeBlobsAsBuffers } = require('../../../resources/blob.ts');

const jc = JSONCodec();
const HDB_CLUSTERING_FOLDER = 'clustering';
const REQUIRED_NATS_SERVER_VERSION = packageJson.engines[natsTerms.NATS_SERVER_NAME];
const DEPENDENCIES_PATH = path.join(PACKAGE_ROOT, 'dependencies');
const NATS_SERVER_PATH = path.join(
	DEPENDENCIES_PATH,
	`${process.platform}-${process.arch}`,
	natsTerms.NATS_BINARY_NAME
);

let leafConfig;
let hubConfig;
let jsmServerName;
let jetstreamManager;
let jetstream;

module.exports = {
	runCommand,
	checkNATSServerInstalled,
	createConnection,
	getConnection,
	getJetStreamManager,
	getJetStream,
	getNATSReferences,
	getServerList,
	createLocalStream,
	listStreams,
	deleteLocalStream,
	getServerConfig,
	listRemoteStreams,
	viewStream,
	viewStreamIterator,
	publishToStream,
	request,
	reloadNATS,
	reloadNATSHub,
	reloadNATSLeaf,
	extractServerName,
	requestErrorHandler,
	createLocalTableStream,
	createTableStreams,
	purgeTableStream,
	purgeSchemaTableStreams,
	getStreamInfo,
	updateLocalStreams,
	closeConnection,
	getJsmServerName,
	addNatsMsgHeader,
	clearClientCache,
	updateRemoteConsumer,
	createConsumer,
	updateConsumerIterator,
};

/**
 * Runs a bash script in a new shell
 * @param {String} command - the command to execute
 * @param {String=} cwd - path to the current working directory
 * @returns {Promise<*>}
 */
async function runCommand(command, cwd = undefined) {
	const { stdout, stderr } = await exec(command, { cwd });

	if (stderr) {
		throw new Error(stderr.replace('\n', ''));
	}

	return stdout.replace('\n', '');
}

/**
 * checks if the NATS Server binary is present, if so is it the correct version
 * @returns {Promise<boolean>}
 */
async function checkNATSServerInstalled() {
	try {
		//check if binary exists
		await fs.access(NATS_SERVER_PATH);
	} catch (e) {
		return false;
	}

	//if nats-server exists check the version
	let versionStr = await runCommand(`${NATS_SERVER_PATH} --version`, undefined);
	let version = versionStr.substring(versionStr.lastIndexOf('v') + 1, versionStr.length);
	return semver.eq(version, REQUIRED_NATS_SERVER_VERSION);
}

/**
 * creates a connection to a NATS server.
 * Returns a connection that you can use to interact with the server.
 * @param port - port to access the NATS server
 * @param username
 * @param password
 * @param waitOnFirstConnect
 * @param host - the host name of the NATS server
 * @returns {Promise<*>}
 */
async function createConnection(port, username, password, waitOnFirstConnect = true, host = '127.0.0.1') {
	if (!username && !password) {
		const cluster_user = await user.getClusterUser();
		if (isEmpty(cluster_user)) {
			throw new Error('Unable to get nats connection. Cluster user is undefined.');
		}

		username = cluster_user.username;
		password = cluster_user.decrypt_hash;
	}

	hdbLogger.trace('create nats connection called');
	const c = await connect({
		name: host,
		port,
		user: username,
		pass: password,
		maxReconnectAttempts: -1,
		waitOnFirstConnect,
		timeout: 200000,
		tls: {
			keyFile: envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_TLS_PRIVATEKEY),
			certFile: envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_TLS_CERTIFICATE),
			caFile: envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_TLS_CERT_AUTH),
			// this is a local connection, with localhost, so we can't verify CAs and don't need to
			rejectUnauthorized: false,
		},
	});

	c.protocol.transport.socket.unref();
	hdbLogger.trace(`create connection established a nats client connection with id`, c?.info?.client_id);

	c.closed().then((err) => {
		if (err) {
			hdbLogger.error('Error with Nats client connection, connection closed', err);
		}
		if (c === natsConnection) clearClientCache();
	});

	return c;
}

function clearClientCache() {
	natsConnection = undefined;
	jetstreamManager = undefined;
	jetstream = undefined;
	natsConnectionPromise = undefined;
}
/**
 * Disconnect from nats-server
 * @returns {Promise<void>}
 */
async function closeConnection() {
	if (natsConnection) {
		await natsConnection.drain();
		natsConnection = undefined;
		jetstreamManager = undefined;
		jetstream = undefined;
		natsConnectionPromise = undefined;
	}
}

/**
 * gets a reference to a NATS connection, if one is stored in global cache then that is returned, otherwise a new connection is created, added to global & returned
 * @returns {Promise<NatsConnection>}
 */
let natsConnection;
let natsConnectionPromise;
async function getConnection() {
	if (!natsConnectionPromise) {
		// first time it will go in here
		natsConnectionPromise = createConnection(
			envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT),
			undefined,
			undefined
		);
		natsConnection = await natsConnectionPromise;
	}
	return natsConnection || natsConnectionPromise; // if we have resolved natsConnection, can short-circuit and return it
}

/**
 * gets a reference to a NATS server JS manager, to do things like created, remove, edit streams & consumers
 * @returns {Promise<JetStreamManager>}
 */
async function getJetStreamManager() {
	if (jetstreamManager) return jetstreamManager;
	if (isEmpty(natsConnection)) {
		await getConnection();
	}

	const { domain } = getServerConfig(hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
	if (isEmpty(domain)) {
		throw new Error('Error getting JetStream domain. Unable to get JetStream manager.');
	}

	jetstreamManager = await natsConnection.jetstreamManager({ domain, timeout: 60000 });
	return jetstreamManager;
}

/**
 * gets a reference to a NATS server JS client, to do things add / delete items from a stream
 * @returns {Promise<JetStreamClient>}
 */
async function getJetStream() {
	if (jetstream) return jetstream;
	if (isEmpty(natsConnection)) {
		await getConnection();
	}
	const { domain } = getServerConfig(hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
	if (isEmpty(domain)) {
		throw new Error('Error getting JetStream domain. Unable to get JetStream manager.');
	}

	jetstream = natsConnection.jetstream({ domain, timeout: 60000 });
	return jetstream;
}

/**
 * creates & returns items that are important for interacting with NATS & Jetstream
 * @returns {Promise<{jsm: JetStreamManager, js: JetStreamClient, connection: NatsConnection}>}
 */
async function getNATSReferences() {
	const connection = natsConnection || (await getConnection());
	const jsm = jetstreamManager || (await getJetStreamManager());
	const js = jetstream || (await getJetStream());

	return {
		connection,
		jsm,
		js,
	};
}

/**
 * gets a list of all nats servers in the cluster
 * @param timeout - the amount of time the request will wait for a response from the Nats network.
 * @returns {Promise<*[]>}
 */
async function getServerList(timeout) {
	const hubPort = envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT);
	const { sys_name, decrypt_hash } = await user.getClusterUser();
	const connection = await createConnection(hubPort, sys_name, decrypt_hash);
	const subj = createInbox();
	const sub = connection.subscribe(subj);
	let servers = [];
	let startTime;
	const getServers = (async () => {
		// get the servers in parallel
		for await (const m of sub) {
			const response = jc.decode(m.data);
			response.response_time = Date.now() - startTime;
			servers.push(response);
		}
	})();

	startTime = Date.now();
	// These are internal Nats subjects used across all servers for accessing server information.
	// https://docs.nats.io/running-a-nats-service/configuration/sysAccounts#available-events-and-services
	// Return general server information. We use it to get which routes exist on each node.
	await connection.publish('$SYS.REQ.SERVER.PING.VARZ', undefined, { reply: subj });
	// Discover all connected servers. We use it to see which nodes are connected to this one
	// and all connected nodes within the cluster from this nodes point of view.
	await connection.publish('$SYS.REQ.SERVER.PING', undefined, { reply: subj });
	await connection.flush();
	await hdbUtils.asyncSetTimeout(timeout); // delay for NATS to process published messages
	await sub.drain();
	await connection.close();
	await getServers; // make sure we have finished getting the servers

	return servers;
}

/**
 * creates a stream to listen to specific subjects (this is intended to create transaction log streams, other general streams but not for work queues)
 * @param {String} stream_name - name of stream to create
 * @param {[String]} subjects - list of subject that will have messages for the stream
 * @returns {Promise<void>}
 */
async function createLocalStream(stream_name, subjects) {
	const { jsm } = await getNATSReferences();
	let maxAge = envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXAGE);
	// If no max age in hdb config set to 0 which is unlimited. If config exists convert second to nanosecond
	maxAge = maxAge === null ? 0 : maxAge * 1000000000;
	let maxMsgs = envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXMSGS);
	maxMsgs = maxMsgs === null ? -1 : maxMsgs; // -1 is unlimited
	let maxBytes = envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXBYTES);
	maxBytes = maxBytes === null ? -1 : maxBytes; // -1 is unlimited
	await jsm.streams.add({
		name: stream_name,
		storage: StorageType.File,
		retention: RetentionPolicy.Limits,
		subjects,
		discard: DiscardPolicy.Old,
		maxMsgs,
		maxBytes,
		maxAge,
	});
}

/**
 * lists all of the streams on this node
 * @returns {Promise<*[]>}
 */
async function listStreams() {
	const { jsm } = await getNATSReferences();
	const streams = await jsm.streams.list().next();
	let streamsInfo = [];
	streams.forEach((si) => {
		streamsInfo.push(si);
	});

	return streamsInfo;
}

/**
 * Delete a stream
 * @param {String} stream_name - name of stream to delete
 * @returns {Promise<void>}
 */
async function deleteLocalStream(stream_name) {
	const { jsm } = await getNATSReferences();
	await jsm.streams.delete(stream_name);
}

/**
 * list the streams from a remote node, based on it's domain name
 * @param {String} domainName
 * @returns {Promise<*[]>}
 */
async function listRemoteStreams(domainName) {
	const { connection } = await getNATSReferences();
	let streams = [];
	const subj = createInbox();
	const sub = connection.subscribe(subj);

	const getStreams = (async () => {
		for await (const m of sub) {
			streams.push(jc.decode(m.data));
		}
	})();

	await connection.publish(`$JS.${domainName}.API.STREAM.LIST`, undefined, { reply: subj });
	await connection.flush();
	await sub.drain();
	// Make sure we have got all the streams
	await getStreams;

	return streams;
}

/**
 * returns the contents of a stream
 * @param stream_name
 * @param startTime - get messages from this time onward
 * @param max - maximum number of messages to receive
 * @returns {Promise<*[]>}
 */
async function viewStream(stream_name, startTime = undefined, max = undefined) {
	const { jsm, js } = await getNATSReferences();
	const consumerName = ulid();
	const consumerConfig = {
		durable_name: consumerName,
		ack_policy: AckPolicy.Explicit,
	};

	// If a start time is passed add a policy that will receive msgs from that time onward.
	if (startTime) {
		consumerConfig.deliver_policy = DeliverPolicy.StartTime;
		consumerConfig.opt_start_time = new Date(startTime).toISOString();
	}

	await jsm.consumers.add(stream_name, consumerConfig);
	const consumer = await js.consumers.get(stream_name, consumerName);
	const messages = !max ? await consumer.consume() : await consumer.fetch({ max_messages: max, expires: 2000 });
	if (consumer._info.num_pending === 0) return [];

	let entries = [];
	for await (const m of messages) {
		const obj = decode(m.data);
		let wrapper = {
			nats_timestamp: m.info.timestampNanos,
			nats_sequence: m.info.streamSequence,
			entry: obj,
		};

		if (m.headers) {
			wrapper.origin = m.headers.get(natsTerms.MSG_HEADERS.ORIGIN);
		}

		entries.push(wrapper);
		m.ack();

		// if no pending, then we have processed the stream
		// and we can break
		if (m.info.pending === 0) {
			break;
		}
	}

	await consumer.delete();

	return entries;
}

/**
 * Returns view of stream via an iterator.
 * @param stream_name
 * @param startTime
 * @param max
 * @returns {AsyncGenerator<{entry: any, nats_timestamp: number, nats_sequence: number, originators: *[]}, *[], *>}
 */
async function* viewStreamIterator(stream_name, startTime = undefined, max = undefined) {
	const { jsm, js } = await getNATSReferences();
	const consumerName = ulid();
	const consumerConfig = {
		durable_name: consumerName,
		ack_policy: AckPolicy.Explicit,
	};

	// If a start time is passed add a policy that will receive msgs from that time onward.
	if (startTime) {
		consumerConfig.deliver_policy = DeliverPolicy.StartTime;
		consumerConfig.opt_start_time = new Date(startTime).toISOString();
	}

	await jsm.consumers.add(stream_name, consumerConfig);
	const consumer = await js.consumers.get(stream_name, consumerName);
	const messages = !max ? await consumer.consume() : await consumer.fetch({ max_messages: max, expires: 2000 });
	if (consumer._info.num_pending === 0) return [];

	for await (const m of messages) {
		let objects = decode(m.data);
		if (!objects[0]) objects = [objects];
		for (let obj of objects) {
			let wrapper = {
				nats_timestamp: m.info.timestampNanos,
				nats_sequence: m.info.streamSequence,
				entry: obj,
			};

			if (m.headers) {
				wrapper.origin = m.headers.get(natsTerms.MSG_HEADERS.ORIGIN);
			}

			yield wrapper;
		}

		m.ack();

		if (m.info.pending === 0) {
			break;
		}
	}
	await consumer.delete();
}

/**
 * publishes message(s) to a stream
 * @param {String} subjectName - name of subject to publish to
 * @param {String} stream_name - the name of the NATS stream
 * @param {} message - message to publish to the stream
 * @param {} msgHeader - header to attach to msg being published to stream
 * @returns {Promise<void>}
 */
async function publishToStream(subjectName, stream_name, msgHeader, message) {
	hdbLogger.trace(
		`publishToStream called with subject: ${subjectName}, stream: ${stream_name}, entries:`,
		message.operation
	);

	msgHeader = addNatsMsgHeader(message, msgHeader);

	const { js } = await getNATSReferences();
	const natsServer = await getJsmServerName();
	const subject = `${subjectName}.${natsServer}`;
	let encodedMessage = await encodeBlobsAsBuffers(() =>
		message instanceof Uint8Array
			? message // already encoded
			: encoder.encode(message)
	);

	try {
		hdbLogger.trace(`publishToStream publishing to subject: ${subject}`);
		recordAction(encodedMessage.length, 'bytes-sent', subjectName, message.operation, 'replication');
		await js.publish(subject, encodedMessage, { headers: msgHeader });
	} catch (err) {
		// If the stream doesn't exist it is created and published to
		if (err.code && err.code.toString() === '503') {
			return exclusiveLock(async () => {
				// try again once we have the lock
				try {
					await js.publish(subject, encodedMessage, { headers: msgHeader });
				} catch (error) {
					if (err.code && err.code.toString() === '503') {
						hdbLogger.trace(`publishToStream creating stream: ${stream_name}`);
						let subjectParts = subject.split('.');
						subjectParts[2] = '*';
						await createLocalStream(stream_name, [subject] /*[subjectParts.join('.')]*/);
						await js.publish(subject, encodedMessage, { headers: msgHeader });
					} else {
						throw err;
					}
				}
			});
		} else {
			throw err;
		}
	}
}

/**
 * Can create a nats header (which essential is a map) and add msg id
 * and origin properties if they don't already exist.
 * @param req
 * @param natsMsgHeader
 * @returns {*}
 */
function addNatsMsgHeader(req, natsMsgHeader) {
	if (natsMsgHeader === undefined) natsMsgHeader = headers();
	const node_name = envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME);

	if (!natsMsgHeader.has(natsTerms.MSG_HEADERS.ORIGIN) && node_name) {
		natsMsgHeader.append(natsTerms.MSG_HEADERS.ORIGIN, node_name);
	}

	return natsMsgHeader;
}

/**
 * Gets some of the server config that is needed by other functions
 * @param processName - The process name processManagement gives the server
 * @returns {undefined|{server_name: string, port: *}}
 */
function getServerConfig(processName) {
	processName = processName.toLowerCase();
	const hdbNatsPath = path.join(envManager.get(hdbTerms.CONFIG_PARAMS.ROOTPATH), HDB_CLUSTERING_FOLDER);

	if (processName === hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_HUB.toLowerCase()) {
		if (isEmpty(hubConfig)) {
			hubConfig = {
				port: configUtils.getConfigFromFile(hdbTerms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT),
				server_name:
					configUtils.getConfigFromFile(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME) + natsTerms.SERVER_SUFFIX.HUB,
				config_file: natsTerms.NATS_CONFIG_FILES.HUB_SERVER,
				pid_file_path: path.join(hdbNatsPath, natsTerms.PID_FILES.HUB),
				hdbNatsPath,
			};
		}

		return hubConfig;
	}

	if (processName === hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF.toLowerCase()) {
		if (isEmpty(leafConfig)) {
			leafConfig = {
				port: configUtils.getConfigFromFile(hdbTerms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT),
				server_name:
					configUtils.getConfigFromFile(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME) + natsTerms.SERVER_SUFFIX.LEAF,
				config_file: natsTerms.NATS_CONFIG_FILES.LEAF_SERVER,
				domain:
					configUtils.getConfigFromFile(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME) + natsTerms.SERVER_SUFFIX.LEAF,
				pid_file_path: path.join(hdbNatsPath, natsTerms.PID_FILES.LEAF),
				hdbNatsPath,
			};
		}

		return leafConfig;
	}

	hdbLogger.error(`Unable to get Nats server config. Unrecognized process: ${processName}`);
	return undefined;
}

/**
 * Creates a consumer, the typical use case is to create a consumer to be used by a remote node for replicated data ingest.
 * @param jsm
 * @param stream_name
 * @param durableName
 * @param startTime
 * @returns {Promise<void>}
 */
async function createConsumer(jsm, stream_name, durableName, startTime) {
	try {
		await jsm.consumers.add(stream_name, {
			ack_policy: AckPolicy.Explicit,
			durable_name: durableName,
			deliver_policy: DeliverPolicy.StartTime,
			opt_start_time: startTime,
		});
	} catch (e) {
		if (e.message !== 'consumer already exists') {
			throw e;
		}
	}
}

/**
 * deletes a consumer
 * @param jsm
 * @param stream_name
 * @param durableName
 * @returns {Promise<void>}
 */
async function removeConsumer(jsm, stream_name, durableName) {
	await jsm.consumers.delete(stream_name, durableName);
}

/**
 * Gets the server name from the API prefix assuming that the prefix follows
 * this convention $JS.testLeafServer-leaf.API
 * @param apiPrefix
 * @returns {*}
 */
function extractServerName(apiPrefix) {
	return apiPrefix.split('.')[1];
}

/**
 * Makes a request to other nodes
 * @param {String} subject - the subject the request broadcast upon
 * @param {String|Object} data - the data being sent in the request
 * @param {String} [reply] - the subject name that the receiver will use to reply back - optional (defaults to createInbox())
 * @param {Number} [timeout] - how long to wait for a response - optional (defaults to 60000 ms)
 * @returns {Promise<*>}
 */
async function request(subject, data, timeout = 60000, reply = createInbox()) {
	if (!hdbUtils.isObject(data)) {
		throw new Error('data param must be an object');
	}

	const requestData = encoder.encode(data);

	const { connection } = await getNATSReferences();
	let options = {
		timeout,
	};

	if (reply) {
		options.reply = reply;
		options.noMux = true;
	}

	const response = await connection.request(subject, requestData, options);
	return decode(response.data);
}

/**
 * reloads a NATS server based on the supplied pid file
 * @param {String} pid_file_path - path to the pid file for the server to reload
 * @returns {Promise<unknown>}
 */
function reloadNATS(pid_file_path) {
	return new Promise(async (resolve, reject) => {
		const reload = spawn(NATS_SERVER_PATH, ['--signal', `reload=${pid_file_path}`], { cwd: __dirname });
		let procErr;
		let procData;

		reload.on('error', (err) => {
			reject(err);
		});

		reload.stdout.on('data', (data) => {
			procData += data.toString();
		});

		reload.stderr.on('data', (data) => {
			procErr += data.toString();
		});

		reload.stderr.on('close', (data) => {
			if (procErr) {
				reject(procErr);
			}

			resolve(procData);
		});
	});
}

/**
 * calls reload to the NATS hub server
 * @returns {Promise<void>}
 */
async function reloadNATSHub() {
	const { pid_file_path } = getServerConfig(hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_HUB);
	await reloadNATS(pid_file_path);
}

/**
 * calls reload to the NATS leaf server
 * @returns {Promise<void>}
 */
async function reloadNATSLeaf() {
	const { pid_file_path } = getServerConfig(hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
	await reloadNATS(pid_file_path);
}

/**
 * Handles any errors from the request function.
 * @param err
 * @param operation
 * @param remoteNode
 * @returns {string|*}
 */
function requestErrorHandler(err, operation, remoteNode) {
	let errMsg;
	switch (err.code) {
		case ErrorCode.NoResponders:
			errMsg = `Unable to ${operation}, node '${remoteNode}' is not listening.`;
			break;
		case ErrorCode.Timeout:
			errMsg = `Unable to ${operation}, node '${remoteNode}' is listening but did not respond.`;
			break;
		default:
			errMsg = err.message;
			break;
	}

	return errMsg;
}

/**
 * Adds or removes a consumer for a remote node to access
 * @param subscription - a node subscription object
 * @param node_name - name of remote node being added to the work stream
 * @returns {Promise<void>}
 */
async function updateRemoteConsumer(subscription, node_name) {
	const node_domain_name = node_name + natsTerms.SERVER_SUFFIX.LEAF;
	const { connection } = await getNATSReferences();
	const { jsm } = await connectToRemoteJS(node_domain_name);
	const { schema, table } = subscription;
	const stream_name = cryptoHash.createNatsTableStreamName(schema, table);
	const startTime = subscription.start_time ? subscription.start_time : new Date(Date.now()).toISOString();

	// Nats has trouble concurrently updating a stream. This code uses transaction locking to ensure that
	// all updateRemoteConsumer calls run synchronously.
	await exclusiveLock(async () => {
		// Create a consumer that the remote node will use to consumer msgs from this nodes table stream.
		if (subscription.subscribe === true) {
			await createConsumer(jsm, stream_name, connection.info.server_name, startTime);
		} else {
			// There might not be a consumer for stream on this node, so we squash error.
			try {
				await removeConsumer(jsm, stream_name, connection.info.server_name);
			} catch (err) {
				hdbLogger.trace(err);
			}
		}
	});
}

async function updateConsumerIterator(database, table, node_name, status) {
	const stream_name = cryptoHash.createNatsTableStreamName(database, table);
	const node_domain_name = node_name + natsTerms.SERVER_SUFFIX.LEAF;
	const message = {
		type: hdbTerms.ITC_EVENT_TYPES.NATS_CONSUMER_UPDATE,
		status,
		stream_name,
		node_domain_name,
	};

	// If the thread calling this is also an ingest thread, it will need to update its own consumer setup
	if (
		!isMainThread &&
		(getWorkerIndex() < envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXINGESTTHREADS) ??
			MAX_INGEST_THREADS)
	) {
		const { updateConsumer } = require('../natsIngestService.js');
		await updateConsumer(message);
	}

	await broadcast(message);

	if (status === 'stop') {
		await hdbUtils.asyncSetTimeout(1000);
	}
}

function exclusiveLock(callback) {
	return transaction.writeTransaction(
		hdbTerms.SYSTEM_SCHEMA_NAME,
		hdbTerms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME,
		callback
	);
}
/**
 * Creates a local stream for a table.
 * @param schema
 * @param table
 * @returns {Promise<void>}
 */
async function createLocalTableStream(schema, table) {
	const stream_name = cryptoHash.createNatsTableStreamName(schema, table);
	const natsServer = await getJsmServerName();
	const subject = createSubjectName(schema, table, natsServer);
	await createLocalStream(stream_name, [subject]);
}

/**
 * Creates multiple streams for multiple tables
 * @param subscriptions - subscription array that is passed into add/update node
 * @returns {Promise<void>}
 */
async function createTableStreams(subscriptions) {
	for (let j = 0, subLength = subscriptions.length; j < subLength; j++) {
		const schema = subscriptions[j].schema;
		const table = subscriptions[j].table;
		await createLocalTableStream(schema, table);
	}
}

/**
 * Removes all entries from a local tables stream.
 * @param schema
 * @param table
 * @param options
 * @returns {Promise<void>}
 */
async function purgeTableStream(schema, table, options = undefined) {
	if (envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		try {
			const stream_name = cryptoHash.createNatsTableStreamName(schema, table);
			const { domain } = getServerConfig(hdbTerms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
			const con = await getConnection();
			// Purging large streams needs a longer timeout than usual
			const jsm = await con.jetstreamManager({ domain, timeout: 240000 });
			await jsm.streams.purge(stream_name, options);
		} catch (err) {
			if (err.message === 'stream not found') {
				// There can be situations where we are trying to purge a stream that doesn't exist.
				// For this reason we do not throw the error if that occurs.
				hdbLogger.warn(err);
			} else {
				throw err;
			}
		}
	}
}

/**
 * Loops through an array of tables and purges each one of their streams.
 * @param schema - schema the tables are in.
 * @param tables - array of table names that are part of the schema.
 * @returns {Promise<void>}
 */
async function purgeSchemaTableStreams(schema, tables) {
	if (envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		for (let x = 0, tableLength = tables.length; x < tableLength; x++) {
			await purgeTableStream(schema, tables[x]);
		}
	}
}

/**
 * Retrieve info about a stream by its name
 * @param stream_name
 * @returns {Promise<StreamInfo>}
 */
async function getStreamInfo(stream_name) {
	const jsm = await getJetStreamManager();
	return jsm.streams.info(stream_name);
}

/**
 * Creates a subject name used for a table when publishing to a stream
 * @param schema
 * @param table
 * @param server
 * @returns {string}
 */
function createSubjectName(schema, table, server) {
	return `${natsTerms.SUBJECT_PREFIXES.TXN}.${schema}${table ? '.' + table : ''}.${server}`;
}

/**
 * Get the name of the server running the jetstream manager - most likely the leaf
 * @returns {Promise<*>}
 */
async function getJsmServerName() {
	if (jsmServerName) return jsmServerName;
	const jsm = await getJetStreamManager();
	jsmServerName = jsm?.nc?.info?.server_name;
	if (jsmServerName === undefined) throw new Error('Unable to get jetstream manager server name');
	return jsmServerName;
}

/**
 * Updates the node name part of the subject of all local streams or stream limits, if it needs updating.
 * @returns {Promise<void>}
 */
async function updateLocalStreams() {
	const jsm = await getJetStreamManager();
	// Server name is the node name with `-leaf` appended to the end of it.
	const server_name = await getJsmServerName();

	const streams = await listStreams();
	for (const stream of streams) {
		const streamConfig = stream.config;
		const streamSubject = streamConfig.subjects[0];
		if (!streamSubject) continue;

		const limitUpdated = updateStreamLimits(stream);

		// Dots are not allowed in node name so spilt on dot, get last item in array which gives us server name (node name with -leaf on the end).
		const streamSubjectArray = streamSubject.split('.');
		const subjectServerName = streamSubjectArray[streamSubjectArray.length - 1];
		if (subjectServerName === server_name && !limitUpdated) continue;

		if (streamConfig.name === '__HARPERDB_WORK_QUEUE__') continue;

		// Build the new subject name and replace existing one with it.
		const subjectArray = streamSubject.split('.');
		subjectArray[subjectArray.length - 1] = server_name;
		const newSubjectName = subjectArray.join('.');
		hdbLogger.trace(`Updating stream subject name from: ${streamSubject} to: ${newSubjectName}`);
		streamConfig.subjects[0] = newSubjectName;

		await jsm.streams.update(streamConfig.name, streamConfig);
	}
}

/**
 * Will compare the stream limit config vs what's in harperdb config.
 * If values are different it will update the stream config so it matches harperdb config.
 * @param stream
 * @returns {boolean}
 */
function updateStreamLimits(stream) {
	const { config } = stream;
	let update = false;
	let maxAge = envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXAGE);
	// We don't store the default (unlimited) values in our config, so we must update for comparison to work.
	// We use seconds for max age, nats uses nanoseconds. This is why we are doing the conversion.
	maxAge = maxAge === null ? 0 : maxAge * 1000000000; // 0 is unlimited
	let maxBytes = envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXBYTES);
	maxBytes = maxBytes === null ? -1 : maxBytes; // -1 is unlimited
	let maxMsgs = envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXMSGS);
	maxMsgs = maxMsgs === null ? -1 : maxMsgs; // -1 is unlimited

	if (maxAge !== config.max_age) {
		config.max_age = maxAge;
		update = true;
	}

	if (maxBytes !== config.max_bytes) {
		config.max_bytes = maxBytes;
		update = true;
	}

	if (maxMsgs !== config.max_msgs) {
		config.max_msgs = maxMsgs;
		update = true;
	}

	return update;
}

/**
 * connects to a remote nodes jetstream
 * @param domain
 * @returns {Promise<{jsm: undefined, js}>}
 */
async function connectToRemoteJS(domain) {
	let js, jsm;
	try {
		js = await natsConnection.jetstream({ domain });
		jsm = await natsConnection.jetstreamManager({ domain, checkAPI: false });
	} catch (err) {
		hdbLogger.error('Unable to connect to:', domain);
		throw err;
	}

	return { js, jsm };
}
