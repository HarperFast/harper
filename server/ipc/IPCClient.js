'use strict';

const raw_ipc = require('node-ipc').IPC;
const hdb_utils = require('../../utility/common_utils');
const hdb_terms = require('../../utility/hdbTerms');
const hdb_logger = require('../../utility/logging/harper_logger');
const { IPC_ERRORS } = require('../../utility/errors/commonErrors');
const os = require('os');

/**
 * This class defines an IPC client. A client will emit event to the IPC server.
 */
class IPCClient {
	constructor(id, event_handlers) {
		this.ipc = new raw_ipc();
		this.server_name = hdb_terms.HDB_IPC_SERVER;
		this.ipc.config.retry = os.platform() == 'win32' ? 600000 : 100; // Windows can have problems, don't constantly reconnect
		this.ipc.config.id = hdb_terms.HDB_IPC_CLIENT_PREFIX + id;
		this.ipc.config.silent = true;
		this.event_handlers = event_handlers;
		this.connect();
	}

	connect() {
		this.ipc.connectTo(this.server_name, () => {
			this.generateEventHandlers(this.event_handlers);
		});
	}

	addEventHandler(event, event_function) {
		this.ipc.of[this.server_name].on(event, event_function);
	}

	generateEventHandlers(event_handlers) {
		this.ipc.of[this.server_name].on('connect', () => {
			hdb_logger.info(`IPC client ${this.ipc.config.id} connected to ${this.server_name}`);
		});

		this.ipc.of[this.server_name].on('disconnect', () => {
			hdb_logger.info(`IPC client ${this.ipc.config.id} disconnected from ${this.server_name}`);
		});

		this.ipc.of[this.server_name].on('error', (error) => {
			if (error.code === 'ECONNREFUSED')
				hdb_logger.warn('Error connecting to HDB IPC server. Confirm that the server is running.');
			hdb_logger.warn(`Error with IPC client ${this.ipc.config.id}`);
			hdb_logger.warn(error);
		});

		for (const [key, value] of Object.entries(event_handlers)) {
			this.addEventHandler(key, value);
		}
	}

	emitToServer(data) {
		if (typeof data !== 'object') {
			hdb_logger.warn(IPC_ERRORS.INVALID_IPC_DATA_TYPE);
			throw new Error(IPC_ERRORS.INVALID_IPC_DATA_TYPE);
		}

		if (hdb_utils.isEmpty(data.type)) {
			hdb_logger.warn(IPC_ERRORS.MISSING_TYPE);
			throw new Error(IPC_ERRORS.MISSING_TYPE);
		}

		if (hdb_utils.isEmpty(data.message)) {
			hdb_logger.warn(IPC_ERRORS.MISSING_MSG);
			throw new Error(IPC_ERRORS.MISSING_MSG);
		}

		hdb_logger.trace(`IPC client ${this.ipc.config.id} emitting`, data);

		this.ipc.of[this.server_name].emit('message', data);
	}
}

module.exports = IPCClient;
