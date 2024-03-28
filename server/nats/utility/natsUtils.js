'use strict';

const env_manager = require('../../../utility/environment/environmentManager');
env_manager.initSync();

const fs = require('fs-extra');
const semver = require('semver');
const path = require('path');
const { monotonicFactory } = require('ulidx');
const ulid = monotonicFactory();
const util = require('util');
const child_process = require('child_process');
const exec = util.promisify(child_process.exec);
const spawn = child_process.spawn;
const nats_terms = require('./natsTerms');
const hdb_terms = require('../../../utility/hdbTerms');
const hdb_utils = require('../../../utility/common_utils');
const hdb_logger = require('../../../utility/logging/harper_logger');
const crypto_hash = require('../../../security/cryptoHash');
const transaction = require('../../../dataLayer/transaction');
const config_utils = require('../../../config/configUtils');
const { broadcast, onMessageByType, getWorkerIndex } = require('../../threads/manageThreads');
const { isMainThread } = require('worker_threads');
const { Encoder, decode } = require('msgpackr');
const encoder = new Encoder(); // use default encoder options

const { isEmpty } = hdb_utils;
const user = require('../../../security/user');

const INGEST_MAX_MSG_AGE = 48 * 3600000000000; // nanoseconds
const INGEST_MAX_BYTES = 5000000000;
const MAX_INGEST_THREADS = 2; // This can also be set in harperdb-config

// Max delay between attempts to connect to remote node
const MAX_REMOTE_CON_RETRY_DELAY = 10000;

if (isMainThread) {
	onMessageByType(hdb_terms.ITC_EVENT_TYPES.RESTART, () => {
		nats_connection = undefined;
		nats_connection_promise = undefined;
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
const { PACKAGE_ROOT } = require('../../../utility/hdbTerms');

const pkg_json = require('../../../package.json');
const { recordAction } = require('../../../resources/analytics');

const jc = JSONCodec();
const HDB_CLUSTERING_FOLDER = 'clustering';
const REQUIRED_NATS_SERVER_VERSION = pkg_json.engines[nats_terms.NATS_SERVER_NAME];
const DEPENDENCIES_PATH = path.join(PACKAGE_ROOT, 'dependencies');
const NATS_SERVER_PATH = path.join(
	DEPENDENCIES_PATH,
	`${process.platform}-${process.arch}`,
	nats_terms.NATS_BINARY_NAME
);

let leaf_config;
let hub_config;
let jsm_server_name;
let jetstream_manager;
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
	let version_str = await runCommand(`${NATS_SERVER_PATH} --version`, undefined);
	let version = version_str.substring(version_str.lastIndexOf('v') + 1, version_str.length);
	return semver.eq(version, REQUIRED_NATS_SERVER_VERSION);
}

/**
 * creates a connection to a NATS server.
 * Returns a connection that you can use to interact with the server.
 * @param port - port to access the NATS server
 * @param username
 * @param password
 * @param wait_on_first_connect
 * @param host - the host name of the NATS server
 * @returns {Promise<*>}
 */
async function createConnection(port, username, password, wait_on_first_connect = true, host = '127.0.0.1') {
	if (!username && !password) {
		const cluster_user = await user.getClusterUser();
		if (isEmpty(cluster_user)) {
			throw new Error('Unable to get nats connection. Cluster user is undefined.');
		}

		username = cluster_user.username;
		password = cluster_user.decrypt_hash;
	}

	hdb_logger.trace('create nats connection called');
	const c = await connect({
		name: host,
		port: port,
		user: username,
		pass: password,
		maxReconnectAttempts: -1,
		waitOnFirstConnect: wait_on_first_connect,
		timeout: 200000,
		tls: {
			keyFile: env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_TLS_PRIVATEKEY),
			certFile: env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_TLS_CERTIFICATE),
			caFile: env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_TLS_CERT_AUTH),
			// this is a local connection, with localhost, so we can't verify CAs and don't need to
			rejectUnauthorized: false,
		},
	});

	c.protocol.transport.socket.unref();
	hdb_logger.trace(`create connection established a nats client connection with id`, c?.info?.client_id);

	c.closed().then((err) => {
		if (err) {
			hdb_logger.error('Error with Nats client connection, connection closed', err);
		}

		clearClientCache();
	});

	return c;
}

function clearClientCache() {
	nats_connection = undefined;
	jetstream_manager = undefined;
	jetstream = undefined;
	nats_connection_promise = undefined;
}

/**
 * Disconnect from nats-server
 * @returns {Promise<void>}
 */
async function closeConnection() {
	if (nats_connection) {
		await nats_connection.drain();
		nats_connection = undefined;
		jetstream_manager = undefined;
		jetstream = undefined;
		nats_connection_promise = undefined;
	}
}

/**
 * gets a reference to a NATS connection, if one is stored in global cache then that is returned, otherwise a new connection is created, added to global & returned
 * @returns {Promise<NatsConnection>}
 */
let nats_connection;
let nats_connection_promise;
async function getConnection() {
	if (!nats_connection_promise) {
		// first time it will go in here
		nats_connection_promise = createConnection(
			env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT),
			undefined,
			undefined
		);
		nats_connection = await nats_connection_promise;
	}
	return nats_connection || nats_connection_promise; // if we have resolved nats_connection, can short-circuit and return it
}

/**
 * gets a reference to a NATS server JS manager, to do things like created, remove, edit streams & consumers
 * @returns {Promise<JetStreamManager>}
 */
async function getJetStreamManager() {
	if (jetstream_manager) return jetstream_manager;
	if (isEmpty(nats_connection)) {
		await getConnection();
	}

	const { domain } = getServerConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
	if (isEmpty(domain)) {
		throw new Error('Error getting JetStream domain. Unable to get JetStream manager.');
	}

	jetstream_manager = await nats_connection.jetstreamManager({ domain, timeout: 60000 });
	return jetstream_manager;
}

/**
 * gets a reference to a NATS server JS client, to do things add / delete items from a stream
 * @returns {Promise<JetStreamClient>}
 */
async function getJetStream() {
	if (jetstream) return jetstream;
	if (isEmpty(nats_connection)) {
		await getConnection();
	}

	const { domain } = getServerConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
	if (isEmpty(domain)) {
		throw new Error('Error getting JetStream domain. Unable to get JetStream manager.');
	}

	jetstream = nats_connection.jetstream({ domain, timeout: 60000 });
	return jetstream;
}

/**
 * creates & returns items that are important for interacting with NATS & Jetstream
 * @returns {Promise<{jsm: JetStreamManager, js: JetStreamClient, connection: NatsConnection}>}
 */
async function getNATSReferences() {
	const connection = nats_connection || (await getConnection());
	const jsm = jetstream_manager || (await getJetStreamManager());
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
	const hub_port = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT);
	const { sys_name, decrypt_hash } = await user.getClusterUser();
	const connection = await createConnection(hub_port, sys_name, decrypt_hash);
	const subj = createInbox();
	const sub = connection.subscribe(subj);
	let servers = [];
	let start_time;
	const get_servers = (async () => {
		// get the servers in parallel
		for await (const m of sub) {
			const response = jc.decode(m.data);
			response.response_time = Date.now() - start_time;
			servers.push(response);
		}
	})();

	start_time = Date.now();
	// These are internal Nats subjects used across all servers for accessing server information.
	// https://docs.nats.io/running-a-nats-service/configuration/sys_accounts#available-events-and-services
	// Return general server information. We use it to get which routes exist on each node.
	await connection.publish('$SYS.REQ.SERVER.PING.VARZ', undefined, { reply: subj });
	// Discover all connected servers. We use it to see which nodes are connected to this one
	// and all connected nodes within the cluster from this nodes point of view.
	await connection.publish('$SYS.REQ.SERVER.PING', undefined, { reply: subj });
	await connection.flush();
	await hdb_utils.async_set_timeout(timeout); // delay for NATS to process published messages
	await sub.drain();
	await connection.close();
	await get_servers; // make sure we have finished getting the servers

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
	let max_age = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXAGE);
	// If no max age in hdb config set to 0 which is unlimited. If config exists convert second to nanosecond
	max_age = max_age === null ? 0 : max_age * 1000000000;
	let max_msgs = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXMSGS);
	max_msgs = max_msgs === null ? -1 : max_msgs; // -1 is unlimited
	let max_bytes = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXBYTES);
	max_bytes = max_bytes === null ? -1 : max_bytes; // -1 is unlimited
	await jsm.streams.add({
		name: stream_name,
		storage: StorageType.File,
		retention: RetentionPolicy.Limits,
		subjects: subjects,
		discard: DiscardPolicy.Old,
		max_msgs,
		max_bytes,
		max_age,
	});
}

/**
 * lists all of the streams on this node
 * @returns {Promise<*[]>}
 */
async function listStreams() {
	const { jsm } = await getNATSReferences();
	const streams = await jsm.streams.list().next();
	let streams_info = [];
	streams.forEach((si) => {
		streams_info.push(si);
	});

	return streams_info;
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
 * @param {String} domain_name
 * @returns {Promise<*[]>}
 */
async function listRemoteStreams(domain_name) {
	const { connection } = await getNATSReferences();
	let streams = [];
	const subj = createInbox();
	const sub = connection.subscribe(subj);

	const get_streams = (async () => {
		for await (const m of sub) {
			streams.push(jc.decode(m.data));
		}
	})();

	await connection.publish(`$JS.${domain_name}.API.STREAM.LIST`, undefined, { reply: subj });
	await connection.flush();
	await sub.drain();
	// Make sure we have got all the streams
	await get_streams;

	return streams;
}

/**
 * returns the contents of a stream
 * @param stream_name
 * @param start_time - get messages from this time onward
 * @param max - maximum number of messages to receive
 * @returns {Promise<*[]>}
 */
async function viewStream(stream_name, start_time = undefined, max = undefined) {
	const { jsm, js } = await getNATSReferences();
	const consumer_name = ulid();
	const consumer_config = {
		durable_name: consumer_name,
		ack_policy: AckPolicy.Explicit,
	};

	// If a start time is passed add a policy that will receive msgs from that time onward.
	if (start_time) {
		consumer_config.deliver_policy = DeliverPolicy.StartTime;
		consumer_config.opt_start_time = new Date(start_time).toISOString();
	}

	await jsm.consumers.add(stream_name, consumer_config);
	const consumer = await js.consumers.get(stream_name, consumer_name);
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
			wrapper.origin = m.headers.get(nats_terms.MSG_HEADERS.ORIGIN);
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
 * @param start_time
 * @param max
 * @returns {AsyncGenerator<{entry: any, nats_timestamp: number, nats_sequence: number, originators: *[]}, *[], *>}
 */
async function* viewStreamIterator(stream_name, start_time = undefined, max = undefined) {
	const { jsm, js } = await getNATSReferences();
	const consumer_name = ulid();
	const consumer_config = {
		durable_name: consumer_name,
		ack_policy: AckPolicy.Explicit,
	};

	// If a start time is passed add a policy that will receive msgs from that time onward.
	if (start_time) {
		consumer_config.deliver_policy = DeliverPolicy.StartTime;
		consumer_config.opt_start_time = new Date(start_time).toISOString();
	}

	await jsm.consumers.add(stream_name, consumer_config);
	const consumer = await js.consumers.get(stream_name, consumer_name);
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
				wrapper.origin = m.headers.get(nats_terms.MSG_HEADERS.ORIGIN);
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
 * @param {String} subject_name - name of subject to publish to
 * @param {String} stream_name - the name of the NATS stream
 * @param {} message - message to publish to the stream
 * @param {} msg_header - header to attach to msg being published to stream
 * @returns {Promise<void>}
 */
async function publishToStream(subject_name, stream_name, msg_header, message) {
	hdb_logger.trace(
		`publishToStream called with subject: ${subject_name}, stream: ${stream_name}, entries:`,
		message.operation
	);

	msg_header = addNatsMsgHeader(message, msg_header);

	const { js } = await getNATSReferences();
	const nats_server = await getJsmServerName();
	const subject = `${subject_name}.${nats_server}`;
	let encoded_message =
		message instanceof Uint8Array
			? message // already encoded
			: encoder.encode(message);

	try {
		hdb_logger.trace(`publishToStream publishing to subject: ${subject}`);
		recordAction(encoded_message.length, 'bytes-sent', subject_name, message.operation, 'replication');
		await js.publish(subject, encoded_message, { headers: msg_header });
	} catch (err) {
		// If the stream doesn't exist it is created and published to
		if (err.code && err.code.toString() === '503') {
			return exclusiveLock(async () => {
				// try again once we have the lock
				try {
					await js.publish(subject, encoded_message, { headers: msg_header });
				} catch (error) {
					if (err.code && err.code.toString() === '503') {
						hdb_logger.trace(`publishToStream creating stream: ${stream_name}`);
						let subject_parts = subject.split('.');
						subject_parts[2] = '*';
						await createLocalStream(stream_name, [subject] /*[subject_parts.join('.')]*/);
						await js.publish(subject, encoded_message, { headers: msg_header });
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
 * @param nats_msg_header
 * @returns {*}
 */
function addNatsMsgHeader(req, nats_msg_header) {
	if (nats_msg_header === undefined) nats_msg_header = headers();
	const node_name = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME);

	if (!nats_msg_header.has(nats_terms.MSG_HEADERS.ORIGIN) && node_name) {
		nats_msg_header.append(nats_terms.MSG_HEADERS.ORIGIN, node_name);
	}

	return nats_msg_header;
}

/**
 * Gets some of the server config that is needed by other functions
 * @param process_name - The process name processManagement gives the server
 * @returns {undefined|{server_name: string, port: *}}
 */
function getServerConfig(process_name) {
	process_name = process_name.toLowerCase();
	const hdb_nats_path = path.join(env_manager.get(hdb_terms.CONFIG_PARAMS.ROOTPATH), HDB_CLUSTERING_FOLDER);

	if (process_name === hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB.toLowerCase()) {
		if (isEmpty(hub_config)) {
			hub_config = {
				port: config_utils.getConfigFromFile(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT),
				server_name:
					config_utils.getConfigFromFile(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME) + nats_terms.SERVER_SUFFIX.HUB,
				config_file: nats_terms.NATS_CONFIG_FILES.HUB_SERVER,
				pid_file_path: path.join(hdb_nats_path, nats_terms.PID_FILES.HUB),
				hdb_nats_path,
			};
		}

		return hub_config;
	}

	if (process_name === hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF.toLowerCase()) {
		if (isEmpty(leaf_config)) {
			leaf_config = {
				port: config_utils.getConfigFromFile(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT),
				server_name:
					config_utils.getConfigFromFile(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME) + nats_terms.SERVER_SUFFIX.LEAF,
				config_file: nats_terms.NATS_CONFIG_FILES.LEAF_SERVER,
				domain:
					config_utils.getConfigFromFile(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME) + nats_terms.SERVER_SUFFIX.LEAF,
				pid_file_path: path.join(hdb_nats_path, nats_terms.PID_FILES.LEAF),
				hdb_nats_path,
			};
		}

		return leaf_config;
	}

	hdb_logger.error(`Unable to get Nats server config. Unrecognized process: ${process_name}`);
	return undefined;
}

/**
 * Creates a consumer, the typical use case is to create a consumer to be used by a remote node for replicated data ingest.
 * @param jsm
 * @param stream_name
 * @param durable_name
 * @param start_time
 * @returns {Promise<void>}
 */
async function createConsumer(jsm, stream_name, durable_name, start_time) {
	try {
		await jsm.consumers.add(stream_name, {
			ack_policy: AckPolicy.Explicit,
			durable_name: durable_name,
			deliver_policy: DeliverPolicy.StartTime,
			opt_start_time: start_time,
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
 * @param durable_name
 * @returns {Promise<void>}
 */
async function removeConsumer(jsm, stream_name, durable_name) {
	await jsm.consumers.delete(stream_name, durable_name);
}

/**
 * Gets the server name from the API prefix assuming that the prefix follows
 * this convention $JS.testLeafServer-leaf.API
 * @param api_prefix
 * @returns {*}
 */
function extractServerName(api_prefix) {
	return api_prefix.split('.')[1];
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
	if (!hdb_utils.isObject(data)) {
		throw new Error('data param must be an object');
	}

	const request_data = encoder.encode(data);

	const { connection } = await getNATSReferences();
	let options = {
		timeout,
	};

	if (reply) {
		options.reply = reply;
		options.noMux = true;
	}

	const response = await connection.request(subject, request_data, options);
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
		let proc_err;
		let proc_data;

		reload.on('error', (err) => {
			reject(err);
		});

		reload.stdout.on('data', (data) => {
			proc_data += data.toString();
		});

		reload.stderr.on('data', (data) => {
			proc_err += data.toString();
		});

		reload.stderr.on('close', (data) => {
			if (proc_err) {
				reject(proc_err);
			}

			resolve(proc_data);
		});
	});
}

/**
 * calls reload to the NATS hub server
 * @returns {Promise<void>}
 */
async function reloadNATSHub() {
	const { pid_file_path } = getServerConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB);
	await reloadNATS(pid_file_path);
}

/**
 * calls reload to the NATS leaf server
 * @returns {Promise<void>}
 */
async function reloadNATSLeaf() {
	const { pid_file_path } = getServerConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
	await reloadNATS(pid_file_path);
}

/**
 * Handles any errors from the request function.
 * @param err
 * @param operation
 * @param remote_node
 * @returns {string|*}
 */
function requestErrorHandler(err, operation, remote_node) {
	let err_msg;
	switch (err.code) {
		case ErrorCode.NoResponders:
			err_msg = `Unable to ${operation}, node '${remote_node}' is not listening.`;
			break;
		case ErrorCode.Timeout:
			err_msg = `Unable to ${operation}, node '${remote_node}' is listening but did not respond.`;
			break;
		default:
			err_msg = err.message;
			break;
	}

	return err_msg;
}

/**
 * Adds or removes a consumer for a remote node to access
 * @param subscription - a node subscription object
 * @param node_name - name of remote node being added to the work stream
 * @returns {Promise<void>}
 */
async function updateRemoteConsumer(subscription, node_name) {
	const node_domain_name = node_name + nats_terms.SERVER_SUFFIX.LEAF;
	const { connection } = await getNATSReferences();
	const { jsm } = await connectToRemoteJS(node_domain_name);
	const { schema, table } = subscription;
	const stream_name = crypto_hash.createNatsTableStreamName(schema, table);
	const start_time = subscription.start_time ? subscription.start_time : new Date(Date.now()).toISOString();

	// Nats has trouble concurrently updating a stream. This code uses transaction locking to ensure that
	// all updateRemoteConsumer calls run synchronously.
	await exclusiveLock(async () => {
		// Create a consumer that the remote node will use to consumer msgs from this nodes table stream.
		if (subscription.subscribe === true) {
			await createConsumer(jsm, stream_name, connection.info.server_name, start_time);
		} else {
			// There might not be a consumer for stream on this node, so we squash error.
			try {
				await removeConsumer(jsm, stream_name, connection.info.server_name);
			} catch (err) {
				hdb_logger.trace(err);
			}
		}
	});
}

async function updateConsumerIterator(database, table, node_name, status) {
	const stream_name = crypto_hash.createNatsTableStreamName(database, table);
	const node_domain_name = node_name + nats_terms.SERVER_SUFFIX.LEAF;
	const message = {
		type: hdb_terms.ITC_EVENT_TYPES.NATS_CONSUMER_UPDATE,
		status,
		stream_name,
		node_domain_name,
	};

	// If the thread calling this is also an ingest thread, it will need to update its own consumer setup
	if (
		!isMainThread &&
		(getWorkerIndex() < env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXINGESTTHREADS) ??
			MAX_INGEST_THREADS)
	) {
		const { updateConsumer } = require('../natsIngestService');
		await updateConsumer(message);
	}

	await broadcast(message);

	if (status === 'stop') {
		await hdb_utils.async_set_timeout(1000);
	}
}

function exclusiveLock(callback) {
	return transaction.writeTransaction(
		hdb_terms.SYSTEM_SCHEMA_NAME,
		hdb_terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME,
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
	const stream_name = crypto_hash.createNatsTableStreamName(schema, table);
	const nats_server = await getJsmServerName();
	const subject = createSubjectName(schema, table, nats_server);
	await createLocalStream(stream_name, [subject]);
}

/**
 * Creates multiple streams for multiple tables
 * @param subscriptions - subscription array that is passed into add/update node
 * @returns {Promise<void>}
 */
async function createTableStreams(subscriptions) {
	for (let j = 0, sub_length = subscriptions.length; j < sub_length; j++) {
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
	if (env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		try {
			const stream_name = crypto_hash.createNatsTableStreamName(schema, table);
			const { domain } = getServerConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
			const con = await getConnection();
			// Purging large streams needs a longer timeout than usual
			const jsm = await con.jetstreamManager({ domain, timeout: 240000 });
			await jsm.streams.purge(stream_name, options);
		} catch (err) {
			if (err.message === 'stream not found') {
				// There can be situations where we are trying to purge a stream that doesn't exist.
				// For this reason we do not throw the error if that occurs.
				hdb_logger.warn(err);
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
	if (env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		for (let x = 0, table_length = tables.length; x < table_length; x++) {
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
	return `${nats_terms.SUBJECT_PREFIXES.TXN}.${schema}${table ? '.' + table : ''}.${server}`;
}

/**
 * Get the name of the server running the jetstream manager - most likely the leaf
 * @returns {Promise<*>}
 */
async function getJsmServerName() {
	if (jsm_server_name) return jsm_server_name;
	const jsm = await getJetStreamManager();
	jsm_server_name = jsm?.nc?.info?.server_name;
	if (jsm_server_name === undefined) throw new Error('Unable to get jetstream manager server name');
	return jsm_server_name;
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
		const stream_config = stream.config;
		const stream_subject = stream_config.subjects[0];
		if (!stream_subject) continue;

		const limit_updated = updateStreamLimits(stream);

		// Dots are not allowed in node name so spilt on dot, get last item in array which gives us server name (node name with -leaf on the end).
		const stream_subject_array = stream_subject.split('.');
		const subject_server_name = stream_subject_array[stream_subject_array.length - 1];
		if (subject_server_name === server_name && !limit_updated) continue;

		if (stream_config.name === '__HARPERDB_WORK_QUEUE__') continue;

		// Build the new subject name and replace existing one with it.
		const subject_array = stream_subject.split('.');
		subject_array[subject_array.length - 1] = server_name;
		const new_subject_name = subject_array.join('.');
		hdb_logger.trace(`Updating stream subject name from: ${stream_subject} to: ${new_subject_name}`);
		stream_config.subjects[0] = new_subject_name;

		await jsm.streams.update(stream_config.name, stream_config);
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
	let max_age = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXAGE);
	// We don't store the default (unlimited) values in our config, so we must update for comparison to work.
	// We use seconds for max age, nats uses nanoseconds. This is why we are doing the conversion.
	max_age = max_age === null ? 0 : max_age * 1000000000; // 0 is unlimited
	let max_bytes = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXBYTES);
	max_bytes = max_bytes === null ? -1 : max_bytes; // -1 is unlimited
	let max_msgs = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXMSGS);
	max_msgs = max_msgs === null ? -1 : max_msgs; // -1 is unlimited

	if (max_age !== config.max_age) {
		config.max_age = max_age;
		update = true;
	}

	if (max_bytes !== config.max_bytes) {
		config.max_bytes = max_bytes;
		update = true;
	}

	if (max_msgs !== config.max_msgs) {
		config.max_msgs = max_msgs;
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
		js = await nats_connection.jetstream({ domain });
		jsm = await nats_connection.jetstreamManager({ domain, checkAPI: false });
	} catch (err) {
		hdb_logger.error('Unable to connect to:', domain);
		throw err;
	}

	return { js, jsm };
}
