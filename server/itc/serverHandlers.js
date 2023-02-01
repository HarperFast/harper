'use strict';

const hdb_logger = require('../../utility/logging/harper_logger');
const hdb_terms = require('../../utility/hdbTerms');
const clean_lmdb_map = require('../../utility/lmdb/cleanLMDBMap');
const global_schema = require('../../utility/globalSchema');
const schema_describe = require('../../data_layer/schemaDescribe');
const user_schema = require('../../security/user');
const { validateEvent } = require('../threads/itc');
const harperBridge = require('../../data_layer/harperBridge/harperBridge');
const process = require('process');

/**
 * This object/functions are passed to the ITC client instance and dynamically added as event handlers.
 * @type {{schema: ((function(*): Promise<void>)|*), job: ((function(*): Promise<void>)|*), user: ((function(): Promise<void>)|*)}}
 */
const server_itc_handlers = {
	[hdb_terms.ITC_EVENT_TYPES.SCHEMA]: schemaHandler,
	[hdb_terms.ITC_EVENT_TYPES.USER]: userHandler,
};

/**
 * Updates the global hdb_schema object.
 * @param event
 * @returns {Promise<void>}
 */
async function schemaHandler(event) {
	const validate = validateEvent(event);
	if (validate) {
		hdb_logger.error(validate);
		return;
	}

	hdb_logger.trace(`ITC schemaHandler received schema event:`, event);
	await clean_lmdb_map(event.message);
	await syncSchemaMetadata(event.message);
}

/**
 * Switch statement to handle schema-related messages from other forked processes - i.e. if another process completes an
 * operation that updates schema and, therefore, requires that we update the global schema value for the process
 *
 * @param msg
 * @returns {Promise<void>}
 */
async function syncSchemaMetadata(msg) {
	try {
		// reset current read transactions to ensure that we are getting the very latest data
		harperBridge.resetReadTxn(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME);
		harperBridge.resetReadTxn(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME);
		harperBridge.resetReadTxn(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME);
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

					global.hdb_schema[msg.schema][msg.table] = await schema_describe.describeTable({
						schema: msg.schema,
						table: msg.table,
					});
					break;
				default:
					global_schema.setSchemaDataToGlobal(handleErrorCallback);
					break;
			}
		} else {
			global_schema.setSchemaDataToGlobal(handleErrorCallback);
		}
	} catch (e) {
		hdb_logger.error(e);
	}
}

function handleErrorCallback(err) {
	if (err) {
		hdb_logger.error(err);
	}
}

/**
 * Updates the global hdb_users object by querying the hdb_role table.
 * @param event
 * @returns {Promise<void>}
 */
async function userHandler(event) {
	try {
		harperBridge.resetReadTxn(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.USER_TABLE_NAME);
		harperBridge.resetReadTxn(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.ROLE_TABLE_NAME);
		const validate = validateEvent(event);
		if (validate) {
			hdb_logger.error(validate);
			return;
		}

		hdb_logger.trace(`ITC userHandler ${hdb_terms.HDB_ITC_CLIENT_PREFIX}${process.pid} received user event:`, event);
		await user_schema.setUsersToGlobal();
	} catch (err) {
		hdb_logger.error(err);
	}
}

module.exports = server_itc_handlers;
