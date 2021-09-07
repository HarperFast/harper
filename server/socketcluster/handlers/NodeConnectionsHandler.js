'use strict';

const InterNodeSocketConnector = require('../connector/InterNodeSocketConnector');
const SocketConnector = require('../connector/SocketConnector');
let connector_options = require('../../../json/hdbConnectorOptions');
const IPCClient = require('../../ipc/IPCClient');
const socket_client = require('socketcluster-client');
const sc_objects = require('../socketClusterObjects');
const sc_utils = require('../util/socketClusterUtils');
const log = require('../../../utility/logging/harper_logger');
const crypto_hash = require('../../../security/cryptoHash');
const SubscriptionObject = sc_objects.SubscriptionObject;
// eslint-disable-next-line no-unused-vars
const NodeObject = sc_objects.NodeObject;
const terms = require('../../../utility/hdbTerms');
const types = require('../types');
const env = require('../../../utility/environment/environmentManager');
env.initSync();
const ipc_server_handlers = require('../../ipc/serverHandlers');
const { promisify } = require('util');
const p_sleep = promisify(setTimeout);

class NodeConnectionsHandler {
	constructor(nodes, cluster_user) {
		log.trace('launching NodeConnectionHandler');
		if (!cluster_user) {
			log.warn('no cluster_user, cannot connect to other nodes');
			return;
		}

		this.creds = {
			username: cluster_user.username,
			password: crypto_hash.decrypt(cluster_user.hash),
		};

		this.hdb_ipc = new IPCClient(process.pid, {
			[terms.IPC_EVENT_TYPES.CLUSTER_STATUS_REQUEST]: this.clusterStatus.bind(this),
			[terms.IPC_EVENT_TYPES.SCHEMA]: ipc_server_handlers.schema,
		});

		connector_options.hostname = 'localhost';
		connector_options.port = env.get('CLUSTERING_PORT');
		delete connector_options.query;

		this.cluster_processes = env.get(terms.HDB_SETTINGS_NAMES.MAX_CLUSTERING_PROCESSES);
		if (!this.cluster_processes || isNaN(this.cluster_processes)) {
			this.cluster_processes = terms.HDB_SETTINGS_DEFAULT_VALUES.MAX_CLUSTERING_PROCESSES;
		}

		this.local_sc_connection = new SocketConnector(socket_client, { name: process.pid }, connector_options, this.creds);

		//spawn local connection
		this.nodes = nodes;

		this.connection_timestamps = {};

		//only needed to handle publish as that is the one that needs a watcher / channel
		//sample structure: {"dev:dog":{watcher:()=>{}, channels:{ "edge1": socket}}
		this.publish_channel_connections = {};

		//get nodes & spwan them, watch for node changes
		this.local_sc_connection.subscribe(terms.INTERNAL_SC_CHANNELS.HDB_NODES, this.nodeWatcher.bind(this));

		//used to auto pub/sub the hdb_schema channel across the cluster
		this.HDB_Schema_Subscription = new SubscriptionObject(terms.INTERNAL_SC_CHANNELS.CREATE_SCHEMA, true, true);
		this.HDB_Table_Subscription = new SubscriptionObject(terms.INTERNAL_SC_CHANNELS.CREATE_TABLE, true, true);
		this.HDB_Attribute_Subscription = new SubscriptionObject(terms.INTERNAL_SC_CHANNELS.CREATE_ATTRIBUTE, true, true);
		this.connections = socket_client;
	}

	nodeWatcher(data) {
		if (data.add_node !== undefined) {
			this.addNewNode(data.add_node);
		} else if (data.remove_node !== undefined) {
			this.removeNode(data.remove_node);
		} else if (data.update_node !== undefined) {
			this.update_node(data.update_node);
		}
	}

	async initialize() {
		//sleep to let the SC server & harperdb spin up
		await p_sleep(1000);

		//if the local connection is not yet established we sleep until it is
		while (this.local_sc_connection.socket.state !== this.local_sc_connection.socket.OPEN) {
			await p_sleep(100);
		}
		log.trace('spawn remote connections');
		await this.spawnRemoteConnections(this.nodes);
	}

	/**
	 *
	 * @param  {Array.<NodeObject>} nodes
	 */
	async spawnRemoteConnections(nodes) {
		await nodes.forEach(async (node) => {
			await this.createNewConnection(node);
		});
	}

	async createNewConnection(node) {
		// eslint-disable-next-line global-require
		let options = require('../../../json/interNodeConnectorOptions');
		log.trace(`Creating new connection to ${node.host}`);
		options.hostname = node.host;
		options.port = node.port;
		let additional_info = {
			server_name: node.name,
			client_name: env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY),
			subscriptions: node.subscriptions,
			connected_timestamp: null,
		};
		let connection = new InterNodeSocketConnector(
			socket_client,
			this.local_sc_connection,
			additional_info,
			options,
			this.creds,
			this.connection_timestamps
		);
		await connection.initialize();
		log.trace(`Done initializing new connection to ${node.host}`);
		node.subscriptions.push(this.HDB_Schema_Subscription);
		node.subscriptions.push(this.HDB_Table_Subscription);
		node.subscriptions.push(this.HDB_Attribute_Subscription);
		node.subscriptions.forEach(this.subscriptionManager.bind(this, connection));
	}

	/**
	 *
	 * @param new_node
	 * @returns {Promise<void>}
	 */
	async addNewNode(new_node) {
		try {
			let node_exists = false;
			let connect_keys = Object.keys(this.connections.clients);
			for (let x = 0; x < connect_keys.length; x++) {
				let key = connect_keys[x];
				let socket = this.connections.clients[key];
				if (socket.additional_info && socket.additional_info.server_name === new_node.name) {
					node_exists = true;
					return;
				}
			}

			if (node_exists) {
				log.info(`node ${new_node.name} already exists`);
				return;
			}

			await this.createNewConnection(new_node);
		} catch (e) {
			log.error(e);
		}
	}

	/**
	 *
	 * @param remove_node
	 */
	removeNode(remove_node) {
		try {
			let connect_keys = Object.keys(this.connections.clients);
			for (let x = 0; x < connect_keys.length; x++) {
				let key = connect_keys[x];
				let socket = this.connections.clients[key];
				if (socket.additional_info && socket.additional_info.server_name === remove_node.name) {
					this.connections.destroy(socket);
				}

				//remove node from all publish connections
				for (let channel in this.publish_channel_connections) {
					for (let socket_name in this.publish_channel_connections[channel]) {
						if (socket_name === remove_node.name) {
							delete this.publish_channel_connections[channel][socket_name];
						}
					}
				}
			}
		} catch (e) {
			log.error(e);
		}
	}

	/**
	 * on update we simply remove and readd the node so that all changes take effect properly.
	 * @param update_node
	 */
	async update_node(update_node) {
		try {
			let connect_keys = Object.keys(this.connections.clients);
			for (let x = 0; x < connect_keys.length; x++) {
				let key = connect_keys[x];
				let connection = this.connections.clients[key];
				if (connection.additional_info.server_name === update_node.name) {
					this.removeNode(update_node);
					await this.addNewNode(update_node);
					return;
				}
			}
		} catch (e) {
			log.error(e);
		}
	}

	/**
	 *
	 * @param connection
	 * @param {SubscriptionObject} subscription
	 */
	subscriptionManager(connection, subscription) {
		try {
			if (subscription.publish === true) {
				if (this.publish_channel_connections[subscription.channel] === undefined) {
					this.publish_channel_connections[subscription.channel] = {};
					let sub_channel = this.local_sc_connection.socket.subscribe(subscription.channel);

					sub_channel.watch(this.subscriptionChannelWatcher.bind(this, subscription.channel));
				}

				//add the connection to the channel map
				this.publish_channel_connections[subscription.channel][connection.additional_info.server_name] = connection;
			}

			if (subscription.subscribe === true) {
				//we need to observe the channel remotely and send the data locally
				log.trace(`Worker is subscribing to ${subscription.channel}`);
				connection.subscribe(
					subscription.channel,
					this.assignTransactionToChild.bind(this, subscription.channel, connection.socket)
				);
			}
		} catch (e) {
			log.error(e);
		}
	}

	/**
	 *
	 * @param channel
	 * @param data
	 */
	subscriptionChannelWatcher(channel, data) {
		try {
			// We need to delete the transacted flag here so it isn't evaluated on the remote side.
			if (data.__transacted) {
				delete data.__transacted;
			}
			let connections = Object.values(this.publish_channel_connections[channel]);
			for (let i = 0; i < connections.length; ++i) {
				let connection = connections[i];
				if (
					connection &&
					connection.socket.state === connection.socket.OPEN &&
					connection.socket.authState === connection.socket.AUTHENTICATED
				) {
					let remote_host_name =
						env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY) ===
						connection.socket.additional_info.client_name
							? connection.socket.additional_info.server_name
							: connection.socket.additional_info.client_name;
					if (data.__originator && data.__originator[remote_host_name] === types.ORIGINATOR_SET_VALUE) {
						log.info('Message contains originator matching remote host, swallowing message.');
						continue;
					}
					log.trace(`Worker is publishing to ${channel}`);
					connection.publish(channel, data);
				}
			}
		} catch (e) {
			log.error(e);
		}
	}

	assignTransactionToChild(channel, socket, data) {
		if (data.__transacted) {
			delete data.__transacted;
		}

		try {
			this.local_sc_connection.publish(channel, data);
		} catch (err) {
			log.info(`Middleware objection found on channel: ${channel}. Not consuming message.`);
		}
	}

	clusterStatus(message) {
		let status_response_msg = {
			outbound_connections: [],
			inbound_connections: [],
		};
		if (this.connections && this.connections.clients) {
			let client_keys = Object.keys(this.connections.clients);
			for (let i = 0; i < client_keys.length; i++) {
				let client = this.connections.clients[client_keys[i]];
				let conn = new sc_utils.ConnectionDetails(
					client.id,
					client.options.hostname,
					client.options.port,
					client.state
				);
				if (client.additional_info && client.additional_info.subscriptions) {
					conn['subscriptions'] = [];
					conn.node_name = client.additional_info.server_name;
					for (let x = 0; x < client.additional_info.subscriptions.length; x++) {
						let sub = client.additional_info.subscriptions[x];
						if (sub.channel.indexOf(terms.HDB_INTERNAL_SC_CHANNEL_PREFIX) === 0) {
							continue;
						}
						conn.subscriptions.push(sub);
					}
					status_response_msg.outbound_connections.push(conn);
				}
			}
		}

		this.hdb_ipc.emitToServer({
			type: terms.IPC_EVENT_TYPES.CLUSTER_STATUS_RESPONSE + message.message.id,
			message: status_response_msg,
		});
	}
}

module.exports = NodeConnectionsHandler;
