const SocketConnector = require('./SocketConnector');
const sc_util = require('../util/socketClusterUtils');
const log = require('../../../utility/logging/harper_logger');
const hdb_terms = require('../../../utility/hdbTerms');
const env = require('../../../utility/environment/environmentManager');
env.initSync();
const hdb_clustering_connections_path = env.getHdbBasePath() + '/clustering/connections/';
const fs = require('fs-extra');
const global_schema = require('../../../utility/globalSchema');
const util = require('util');
const types = require('../types');
const p_schema_to_global = util.promisify(global_schema.setSchemaDataToGlobal);

const CATCHUP_INTERVAL = 10000;

class InterNodeSocketConnector extends SocketConnector {
	/**
	 * @param socket_client
	 * @param local_connection
	 * @param additional_info
	 * @param options
	 * @param credentials
	 */
	constructor(socket_client, local_connection, additional_info = {}, options = {}, credentials = {}) {
		super(socket_client, additional_info, options, credentials);
		if (additional_info.client_name !== undefined && additional_info.server_name !== undefined) {
			options.query.node_client_name = additional_info.client_name;
			options.query.node_server_name = additional_info.server_name;
		}
		//TODO possibly change this to the node name, rather hostname / port?
		this.connection_path =
			hdb_clustering_connections_path + this.socket.options.hostname + ':' + this.socket.options.port;

		this.local_connection = local_connection;
	}

	async initialize() {
		await p_schema_to_global();
		try {
			//remove any line breaks that may have been added to the file
			this.connected_timestamp = (await fs.readFile(this.connection_path)).toString().replace(/(\r\n|\n|\r)/gm, '');
		} catch (e) {
			if (e.code !== 'ENOENT') {
				log.error(e);
			}
		}
		this.addEventListener('connect', this.connectHandler.bind(this));
		this.addEventListener('disconnect', this.disconnectHandler.bind(this));
		this.addEventListener('catchup_response', this.catchupResponseHandler.bind(this));
	}

	async connectHandler(status) {
		log.trace(`connect handler with status: ${status}`);
		try {
			// we always want to keep all schema/table/attribute info up to date, so always make a schema catchup request.
			let schema_catch_up_msg = await sc_util.schemaCatchupHandler();
			if (schema_catch_up_msg) {
				this.socket.publish(hdb_terms.INTERNAL_SC_CHANNELS.SCHEMA_CATCHUP, schema_catch_up_msg);
			}
			this.socket.emit('schema_catchup', {}, this.catchupResponseHandler.bind(this));

			if (this.additional_info && this.connected_timestamp) {
				//check subscriptions so we can locally fetch catchup and ask for remote catchup
				for (const subscription of this.additional_info.subscriptions) {
					//we want to skip performing catchup requests for hdb_internal
					if (subscription.channel.startsWith(hdb_terms.HDB_INTERNAL_SC_CHANNEL_PREFIX)) {
						continue;
					}

					if (subscription.publish === true) {
						try {
							let catch_up_msg = await sc_util.catchupHandler(subscription.channel, this.connected_timestamp, null);
							if (catch_up_msg) {
								log.trace(`send catchup payload`);
								this.socket.publish(hdb_terms.INTERNAL_SC_CHANNELS.CATCHUP, catch_up_msg);
							}
						} catch (e) {
							log.error(e);
						}
					}

					if (subscription.subscribe === true) {
						//TODO correct the emits with CORE-402
						this.socket.emit(
							'catchup',
							{
								channel: subscription.channel,
								milis_since_connected: Date.now() - this.connected_timestamp,
							},
							this.catchupResponseHandler.bind(this)
						);
					}
				}
			}

			this.interval_id = setInterval(this.recordConnectionTimestamp.bind(this), CATCHUP_INTERVAL);
		} catch (err) {
			log.error('Error during catchup handler.');
			log.error(err);
		}
	}

	disconnectHandler() {
		if (this.interval_id !== undefined) {
			clearInterval(this.interval_id);
		}
	}

	async recordConnectionTimestamp() {
		this.socket.emit(types.EMIT_TYPES.CONNECT_CHECK, {}, async (error, response) => {
			if (error) {
				log.warn(`error on cross node check: ${error}`);
			} else {
				this.connected_timestamp = Date.now();
				log.info(`new connect time: ${this.connected_timestamp}`);
				try {
					await fs.writeFileSync(this.connection_path, this.connected_timestamp.toString());
				} catch (e) {
					log.error(e);
				}
			}
		});
	}

	async catchupResponseHandler(error, catchup_msg) {
		log.debug(`start catchupResponseHandler`);
		if (error) {
			log.info('Error in catchupResponseHandler');
			log.error(error);
			return;
		}

		if (!catchup_msg) {
			log.info('empty catchup response message');
			return;
		}

		try {
			this.local_connection.publish(hdb_terms.INTERNAL_SC_CHANNELS.CATCHUP, catchup_msg);
		} catch (e) {
			log.error(e);
		}
	}
}

module.exports = InterNodeSocketConnector;
