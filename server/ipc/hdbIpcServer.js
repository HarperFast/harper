'use strict';

const ipc = require('node-ipc');
const hdb_utils = require('../../utility/common_utils');
const hdb_terms = require('../../utility/hdbTerms');
const hdb_logger = require('../../utility/logging/harper_logger');
const { IPC_ERRORS } = require('../../utility/errors/commonErrors');
const env = require('../../utility/environment/environmentManager');
if (!env.isInitialized()) env.initSync();

ipc.config.id = hdb_terms.HDB_IPC_SERVER;
ipc.config.networkPort = env.get(hdb_terms.HDB_SETTINGS_NAMES.IPC_SERVER_PORT);
ipc.config.silent = true;
ipc.config.retry= 100;
ipc.config.maxConnections = 1000;

ipc.serve(
  () => {
      ipc.server.on(
          'message', messageListener
      );
      ipc.server.on(
          'connect',
          () => {
              hdb_logger.trace('HDB IPC server connected');
          }
      );
      ipc.server.on(
          'disconnect',
          () => {
              hdb_logger.trace('HDB IPC server disconnected');
          }
      );
      ipc.server.on(
          'error',
          (error) => {
              hdb_logger.error(`IPC server error: ${error}`);
          }
      );
  }
);

/**
 * Validates IPC message and broadcasts to IPC clients.
 * @param data
 */
function messageListener(data) {
    if (typeof data !== 'object') {
        hdb_logger.warn(IPC_ERRORS.INVALID_IPC_DATA_TYPE);
        return;
    }

    if (hdb_utils.isEmpty(data.type)) {
        hdb_logger.warn(IPC_ERRORS.MISSING_TYPE);
        return;
    }

    if (hdb_utils.isEmpty(data.message)) {
        hdb_logger.warn(IPC_ERRORS.MISSING_MSG);
        return;
    }

    const event_type = data.type;
    hdb_logger.trace(`IPC server received a message type ${event_type}, with message ${JSON.stringify(data.message)}`);

    ipc.server.broadcast(
        event_type,
        data
    );
}

ipc.server.start();
hdb_logger.trace(`HDB IPC Server: ${hdb_terms.HDB_IPC_SERVER}, started on port: ${env.get(hdb_terms.HDB_SETTINGS_NAMES.IPC_SERVER_PORT)}`);