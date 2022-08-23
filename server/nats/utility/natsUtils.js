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
const { encode, decode } = require('msgpackr');

const { isEmpty } = hdb_utils;
const user = require('../../../security/user');

const {
	connect,
	StorageType,
	RetentionPolicy,
	AckPolicy,
	DeliverPolicy,
	NatsConnection,
	JetStreamManager,
	JetStreamClient,
	StringCodec,
	JSONCodec,
	createInbox,
	StreamSource,
	headers,
	toJsMsg,
	nuid,
	JetStreamOptions,
	ErrorCode,
} = require('nats');
const { PACKAGE_ROOT } = require('../../../utility/hdbTerms');

const pkg_json = require('../../../package.json');

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

// Nats connection it cached here.
let nats_connection;

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
	publishToStream,
	createWorkQueueStream,
	addSourceToWorkStream,
	request,
	removeSourceFromWorkStream,
	reloadNATS,
	reloadNATSHub,
	reloadNATSLeaf,
	extractServerName,
	requestErrorHandler,
	updateWorkStream,
	createLocalTableStream,
	createTableStreams,
	purgeTableStream,
	purgeSchemaTableStreams,
	getStreamInfo,
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
	return connect({
		name: host,
		port: port,
		user: username,
		pass: password,
		maxReconnectAttempts: -1,
		waitOnFirstConnect: wait_on_first_connect,
		tls: {
			keyFile: env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_TLS_PRIVATEKEY),
			certFile: env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_TLS_CERTIFICATE),
			caFile: env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_TLS_CERT_AUTH),
			insecure: env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_TLS_INSECURE),
		},
	});
}

/**
 * gets a reference to a NATS connection, if one is stored in global cache then that is returned, otherwise a new connection is created, added to global & returned
 * @returns {Promise<NatsConnection>}
 */
async function getConnection() {
	if (!nats_connection) {
		const cluster_user = await user.getClusterUser();
		if (isEmpty(cluster_user)) {
			throw new Error('Unable to get nats connection. Cluster user is undefined.');
		}

		const leaf_port = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT);
		nats_connection = await createConnection(leaf_port, cluster_user.username, cluster_user.decrypt_hash);
	}

	return nats_connection;
}

/**
 * gets a reference to a NATS server JS manager, to do things like created, remove, edit streams & consumers
 * @returns {Promise<JetStreamManager>}
 */
async function getJetStreamManager() {
	if (isEmpty(nats_connection)) {
		await getConnection();
	}

	const { domain } = getServerConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
	if (isEmpty(domain)) {
		throw new Error('Error getting JetStream domain. Unable to get JetStream manager.');
	}

	return nats_connection.jetstreamManager({ domain });
}

/**
 * gets a reference to a NATS server JS client, to do things add / delete items from a stream
 * @returns {Promise<JetStreamClient>}
 */
async function getJetStream() {
	if (isEmpty(nats_connection)) {
		await getConnection();
	}

	const { domain } = getServerConfig(hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_LEAF);
	if (isEmpty(domain)) {
		throw new Error('Error getting JetStream domain. Unable to get JetStream manager.');
	}

	return nats_connection.jetstream({ domain });
}

/**
 * creates & returns items that are important for interacting with NATS & Jetstream
 * @returns {Promise<{jsm: JetStreamManager, js: JetStreamClient, connection: NatsConnection}>}
 */
async function getNATSReferences() {
	const connection = await getConnection();
	const jsm = await getJetStreamManager();
	const js = await getJetStream();

	return {
		connection,
		jsm,
		js,
	};
}

/**
 * gets a list of all nats servers in the cluster
 * @returns {Promise<*[]>}
 */
async function getServerList() {
	const leaf_port = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT);
	const { sys_name, decrypt_hash } = await user.getClusterUser();
	const connection = await createConnection(leaf_port, sys_name, decrypt_hash);
	const subj = createInbox();
	const sub = connection.subscribe(subj);
	let servers = [];
	const get_servers = (async () => {
		// get the servers in parallel
		for await (const m of sub) {
			servers.push(jc.decode(m.data));
		}
	})();

	await connection.publish('$SYS.REQ.SERVER.PING.VARZ', undefined, { reply: subj });
	await connection.flush();
	await hdb_utils.async_set_timeout(50); // delay for NATS to process published messages
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
	await jsm.streams.add({
		name: stream_name,
		storage: StorageType.File,
		retention: RetentionPolicy.Limits,
		subjects: subjects,
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
	const { jsm, connection } = await getNATSReferences();
	const consumer_name = ulid();
	let entries = [];

	const consumer_config = {
		ack_policy: AckPolicy.None,
		durable_name: consumer_name,
		deliver_subject: consumer_name,
		deliver_policy: DeliverPolicy.All,
		filter_subject: '',
	};

	// If a start time is passed add a policy that will receive msgs from that time onward.
	if (start_time) {
		consumer_config.deliver_policy = DeliverPolicy.StartTime;
		consumer_config.opt_start_time = new Date(start_time).toISOString();
	}

	try {
		await jsm.consumers.add(stream_name, consumer_config);

		const sub_config = { timeout: 2000 };
		if (max) sub_config.max = max;
		const sub = await connection.subscribe(consumer_name, sub_config);

		for await (const m of sub) {
			const jmsg = toJsMsg(m);
			const obj = decode(jmsg.data);
			let wrapper = {
				nats_timestamp: jmsg.info.timestampNanos,
				nats_sequence: jmsg.info.streamSequence,
				entry: obj,
				originators: [],
			};
			let orig = [];
			if (jmsg.headers) {
				let orig_raw = jmsg.headers.get('originators');
				if (orig_raw) {
					orig = orig_raw.split(',');
					wrapper.originators = orig;
				}
			}

			entries.push(wrapper);
			if (sub.getPending() === 1 && jmsg.info.pending === 0) {
				sub.stop();
			}
		}

		await jsm.consumers.delete(stream_name, consumer_name);

		return entries;
	} catch (err) {
		await jsm.consumers.delete(stream_name, consumer_name);

		// If the stream has no entries function will timeout. This is handled here.
		if (err.code === 'TIMEOUT') {
			return entries;
		}

		throw err;
	}
}

/**
 * publishes message(s) to a stream
 * @param {String} subject_name - name of subject to publish to
 * @param {String} stream_name - the name of the NATS stream
 * @param {[]} entries - array of entries to publish to the stream
 * @param {[]} originators - list of node names which have previous processed the entry(ies)
 * @returns {Promise<void>}
 */
async function publishToStream(subject_name, stream_name, entries = [], originators = []) {
	hdb_logger.trace(
		`publishToStream called with subject: ${subject_name}, stream: ${stream_name}, entries:`,
		entries,
		`originators:`,
		originators
	);
	const { connection, js, jsm } = await getNATSReferences();
	const nats_server = jsm?.nc?.info?.server_name;
	const subject = `${subject_name}.${nats_server}`;
	try {
		const h = headers();
		originators.push(nats_server);
		h.append('originators', originators.join());
		for (let x = 0, length = entries.length; x < length; x++) {
			try {
				hdb_logger.trace(`publishToStream publishing to subject: ${subject}, data:`, entries[x]);
				await js.publish(subject, encode(entries[x]), { headers: h });
			} catch (err) {
				// If the stream doesn't exist it is created and published to
				if (err.code && err.code.toString() === '503') {
					hdb_logger.trace(`publishToStream creating stream: ${stream_name}`);
					await createLocalStream(stream_name, [subject]);
					await js.publish(subject, encode(entries[x]), { headers: h });
				} else {
					throw err;
				}
			}
		}

		await connection.flush();
	} catch (e) {
		await connection.flush();
		throw e;
	}
}

/**
 * Gets some of the server config that is needed by other functions
 * @param process_name - The process name pm2 gives the server
 * @returns {undefined|{server_name: string, port: *}}
 */
function getServerConfig(process_name) {
	process_name = process_name.toLowerCase();
	const hdb_nats_path = path.join(env_manager.get(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_ROOT), HDB_CLUSTERING_FOLDER);

	if (process_name === hdb_terms.PROCESS_DESCRIPTORS.CLUSTERING_HUB.toLowerCase()) {
		if (isEmpty(hub_config)) {
			hub_config = {
				port: env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_HUBSERVER_NETWORK_PORT),
				server_name: env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME) + nats_terms.SERVER_SUFFIX.HUB,
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
				port: env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_NETWORK_PORT),
				server_name: env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME) + nats_terms.SERVER_SUFFIX.LEAF,
				config_file: nats_terms.NATS_CONFIG_FILES.LEAF_SERVER,
				domain: env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME) + nats_terms.SERVER_SUFFIX.LEAF,
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
 * creates a stream intended to act as a work queue & it's related consumer
 * @param {Object} CONSUMER_NAMES
 * @returns {Promise<void>}
 */
async function createWorkQueueStream(CONSUMER_NAMES) {
	const { jsm } = await getNATSReferences();
	try {
		// create the stream
		await jsm.streams.add({
			name: CONSUMER_NAMES.stream_name,
			storage: StorageType.File,
			retention: RetentionPolicy.Limits,
			subjects: [`${CONSUMER_NAMES.stream_name}.${env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME)}`],
		});
	} catch (err) {
		// If the stream already exists ignore error that is thrown.
		if (err.code !== '400') {
			throw err;
		}
	}

	//check if the consumer exists, if not create a pull based consumer.
	try {
		await jsm.consumers.info(CONSUMER_NAMES.stream_name, CONSUMER_NAMES.durable_name);
	} catch (e) {
		if (e.code.toString() === '404') {
			await jsm.consumers.add(CONSUMER_NAMES.stream_name, {
				ack_policy: AckPolicy.Explicit,
				durable_name: CONSUMER_NAMES.durable_name,
				deliver_policy: DeliverPolicy.All,
				max_ack_pending: 100000000,
			});
		} else {
			throw e;
		}
	}
}

/**
 * sources the message from remote node's stream to a local stream
 * @param {String} node - name of node to derive source from
 * @param {String} work_queue_name - name of local stream to add source to
 * @param {String} stream_name - name of remote stream to source from
 * @returns {Promise<void>}
 */
async function addSourceToWorkStream(node, work_queue_name, stream_name) {
	const { jsm } = await getNATSReferences();
	const w_q_stream = await jsm.streams.info(work_queue_name);
	const server_name = extractServerName(jsm.prefix);

	// Check to see if the source is being added to a local stream. Local streams require a slightly different config.
	const is_local_stream = server_name === node;

	let found = false;
	if (!Array.isArray(w_q_stream.config.sources) || w_q_stream.config.sources.length === 0) {
		w_q_stream.config.sources = [];
	} else {
		for (let x = 0, length = w_q_stream.config.sources.length; x < length; x++) {
			let source = w_q_stream.config.sources[x];
			if (
				(is_local_stream && source.name === stream_name) ||
				(!is_local_stream &&
					source.name === stream_name &&
					source.external &&
					source.external.api === `$JS.${node}.API`)
			) {
				found = true;
				break;
			}
		}
	}

	if (found === true) {
		return;
	}

	let new_source = {
		name: stream_name,
	};

	if (!is_local_stream) {
		new_source.external = {
			api: `$JS.${node}.API`,
			deliver: '',
		};
	}

	w_q_stream.config.sources.push(new_source);
	await jsm.streams.update(work_queue_name, w_q_stream.config);
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
 * Removes a remote node's stream from the source on the local stream
 * @param node - name of node
 * @param work_queue_name - name of local stream to remove source from
 * @param stream_name - name of remote stream to no longer source from
 * @returns {Promise<void>}
 */
async function removeSourceFromWorkStream(node, work_queue_name, stream_name) {
	const { jsm } = await getNATSReferences();
	const w_q_stream = await jsm.streams.info(work_queue_name);
	if (!Array.isArray(w_q_stream.config.sources) || w_q_stream.config.sources.length === 0) {
		return;
	}

	let i = w_q_stream.config.sources.length;
	while (i--) {
		const source = w_q_stream.config.sources[i];
		if (source.name === stream_name && source.external.api === `$JS.${node}.API`) {
			w_q_stream.config.sources.splice(i, 1);
		}
	}

	if (w_q_stream.config.sources.length === 0) {
		delete w_q_stream.config.sources;
	}

	await jsm.streams.update(work_queue_name, w_q_stream.config);
	const wq_stream = await jsm.streams.info(nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name);
}

/**
 * Makes a request to other nodes
 * @param {String} subject - the subject the request broadcast upon
 * @param {String|Object} data - the data being sent in the request
 * @param {String} [reply] - the subject name that the receiver will use to reply back - optional (defaults to createInbox())
 * @param {Number} [timeout] - how long to wait for a response - optional (defaults to 2000 ms)
 * @returns {Promise<*>}
 */
async function request(subject, data, timeout = 2000, reply = createInbox()) {
	if (!hdb_utils.isObject(data)) {
		throw new Error('data param must be an object');
	}

	const request_data = encode(data);

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
 * Adds or removes a remote stream from the work queue stream.
 * @param subscription - a node subscription object
 * @param node_name - name of remote node being added to the work stream
 * @returns {Promise<void>}
 */
async function updateWorkStream(subscription, node_name) {
	const stream_name = crypto_hash.createNatsTableStreamName(subscription.schema, subscription.table);
	const node_domain_name = node_name + nats_terms.SERVER_SUFFIX.LEAF;

	// The connection between nodes can only be a "pull" relationship. This means we only care about the subscribe param.
	// If a node is publishing to another node that publishing relationship is setup by have the opposite node subscribe to the node that is publishing.
	if (subscription.subscribe === true) {
		await addSourceToWorkStream(node_domain_name, nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name, stream_name);
	} else {
		await removeSourceFromWorkStream(node_domain_name, nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name, stream_name);
	}
}

/**
 * Creates a local stream for a table.
 * @param schema
 * @param table
 * @returns {Promise<void>}
 */
async function createLocalTableStream(schema, table) {
	const subject_name = `${schema}.${table}`;
	const stream_name = crypto_hash.createNatsTableStreamName(schema, table);
	const { jsm } = await getNATSReferences();
	const nats_server = jsm?.nc?.info?.server_name;
	const subject = `${subject_name}.${nats_server}`;
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
 * @returns {Promise<void>}
 */
async function purgeTableStream(schema, table) {
	if (env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		try {
			const stream_name = crypto_hash.createNatsTableStreamName(schema, table);
			const { jsm } = await getNATSReferences();
			await jsm.streams.purge(stream_name);
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
