'use strict';

const hdb_logger = require('../../utility/logging/harper_logger');
const hdb_terms = require('../../utility/hdbTerms');
const clean_lmdb_map = require('../../utility/lmdb/cleanLMDBMap');
const global_schema = require('../../utility/globalSchema');
const schema_describe = require('../../data_layer/schemaDescribe');
const user_schema = require('../../security/user');
const job_runner = require('../jobRunner');
const { validateEvent } = require('../../server/ipc/utility/ipcUtils');

/**
 * This object/functions are passed to the IPC client instance and dynamically added as event handlers.
 * @type {{schema: ((function(*): Promise<void>)|*), job: ((function(*): Promise<void>)|*), user: ((function(): Promise<void>)|*)}}
 */
const hdb_child_ipc_handlers = {
    [hdb_terms.IPC_EVENT_TYPES.SCHEMA]: async (event) => {
        const validate = validateEvent(event);
        if (validate) {
            hdb_logger.error(validate);
            return;
        }

        clean_lmdb_map(event.message);
        await syncSchemaMetadata(event.message);
    },
    [hdb_terms.IPC_EVENT_TYPES.USER]: async () => {
        try {
            await user_schema.setUsersToGlobal();
        } catch(err){
            hdb_logger.error(err);
        }
    },
    [hdb_terms.IPC_EVENT_TYPES.JOB]: async (event) => {
        const validate = validateEvent(event);
        if (validate) {
            hdb_logger.error(validate);
            return;
        }

        try {
            const result = await job_runner.parseMessage(event.message);
            hdb_logger.info(`completed job with result: ${JSON.stringify(result)}`);
        } catch(err) {
            hdb_logger.error(err);
        }
    }
};

/**
 * Switch statement to handle schema-related messages from other forked processes - i.e. if another process completes an
 * operation that updates schema and, therefore, requires that we update the global schema value for the process
 *
 * @param msg
 * @returns {Promise<void>}
 */
async function syncSchemaMetadata(msg) {
    try{
        if (global.hdb_schema !== undefined && typeof global.hdb_schema === 'object' && msg.operation !== undefined) {
            switch (msg.operation) {
                case 'drop_schema':
                    delete global.hdb_schema[msg.schema];
                    break;
                case 'drop_table':
                    if (global.hdb_schema[msg.schema] !== undefined) {
                        delete global.hdb_schema[msg.schema][msg.table];
                    }
                    break;
                case 'create_schema':
                    if (global.hdb_schema[msg.schema] === undefined) {
                        global.hdb_schema[msg.schema] = {};
                    }
                    break;
                case 'create_table':
                case 'create_attribute':
                    if (global.hdb_schema[msg.schema] === undefined) {
                        global.hdb_schema[msg.schema] = {};
                    }

                    global.hdb_schema[msg.schema][msg.table] =
                        await schema_describe.describeTable({schema: msg.schema, table: msg.table});
                    break;
                default:
                    global_schema.setSchemaDataToGlobal(handleErrorCallback);
                    break;
            }
        } else{
            global_schema.setSchemaDataToGlobal(handleErrorCallback);
        }
    } catch(e) {
        hdb_logger.error(e);
    }
}

function handleErrorCallback(err) {
    if (err) {
        hdb_logger.error(err);
    }
}

module.exports = hdb_child_ipc_handlers;