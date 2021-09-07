'use strict';
const log = require('../../../utility/logging/harper_logger');
const terms = require('../../../utility/hdbTerms');
class SocketConnector {
	/**
	 *
	 * @param socket_client
	 * @param name
	 * @param options
	 * @param credentials
	 */
	constructor(socket_client, additional_info, options, credentials) {
		this.additional_info = additional_info === undefined ? {} : additional_info;
		this.init(socket_client, options, credentials);
		this.disconnect_timestamp = null;
	}

	init(socket_client, options, credentials) {
		this.socket = socket_client.create(options);

		if (typeof this.additional_info === 'object') {
			this.socket.additional_info = this.additional_info;
		}

		this.socket.on('error', (err, socket) => {
			if (err.message === 'Socket hung up') {
				log.warn('ERROR on HDB Client socket: ' + err);
			} else {
				log.error('ERROR on HDB Client socket: ' + err);
			}
			log.info(err);
		});

		this.socket.on('connect', (status) => {
			this.disconnect_timestamp = null;
			log.debug(`Connected to cluster server.`);
		});

		this.socket.on('disconnect', (status) => {
			this.disconnect_timestamp = Date.now();
			log.debug(
				`Disconnected from cluster server with code: ${status} - ${terms.WEBSOCKET_CLOSE_CODE_DESCRIPTION_LOOKUP[status]}`
			);
		});

		this.socket.on('login', (data, res) => {
			try {
				log.debug('logging in');
				res(null, credentials);
			} catch (e) {
				log.error(e);
			}
		});
	}

	addEventListener(event, listener) {
		this.socket.addEventListener(event, listener);
	}

	subscribe(channel, watcher) {
		this.socket.subscribe(channel).watch(watcher);
	}

	publish(channel, data, handler) {
		this.socket.publish(channel, data, handler);
	}

	emit(event, data) {
		this.socket.emit(event, data);
	}

	status() {
		return {
			active: this.socket.active,
			state: this.socket.state,
			auth_state: this.socket.authState,
		};
	}

	subscriptions() {
		return Object.keys(this.socket.subscriptions(true));
	}

	unsubscribe(channel) {
		this.socket.unsubscribe(channel);
	}

	destroy() {
		this.socket.destroy();
	}
}

module.exports = SocketConnector;
