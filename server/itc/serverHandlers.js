'use strict';

const hdb_logger = require('../../utility/logging/harper_logger');
const hdb_terms = require('../../utility/hdbTerms');
const clean_lmdb_map = require('../../utility/lmdb/cleanLMDBMap');
const global_schema = require('../../utility/globalSchema');
const schema_describe = require('../../dataLayer/schemaDescribe');
const user_schema = require('../../security/user');
const { validateEvent } = require('../threads/itc');
const harperBridge = require('../../dataLayer/harperBridge/harperBridge');
const process = require('process');
const { resetDatabases } = require('../../resources/databases');

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
		// TODO: Eventually should indicate which database/table changed so we don't have to scan everything
		let databases = resetDatabases();
		if (msg.table && msg.database)
			// wait for a write to finish to ensure all writes have been written
			await databases[msg.database][msg.table].put(Symbol.for('write-verify'), null);
	} catch (e) {
		hdb_logger.error(e);
	}
}

function handleErrorCallback(err) {
	if (err) {
		hdb_logger.error(err);
	}
}

const user_listeners = [];
/**
 * Updates the global hdb_users object by querying the hdb_role table.
 * @param event
 * @returns {Promise<void>}
 */
async function userHandler(event) {
	try {
		try {
			harperBridge.resetReadTxn(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.USER_TABLE_NAME);
			harperBridge.resetReadTxn(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.ROLE_TABLE_NAME);
		} catch (error) {
			// this can happen during tests, best to ignore
			hdb_logger.warn(error);
		}
		const validate = validateEvent(event);
		if (validate) {
			hdb_logger.error(validate);
			return;
		}

		hdb_logger.trace(`ITC userHandler ${hdb_terms.HDB_ITC_CLIENT_PREFIX}${process.pid} received user event:`, event);
		await user_schema.setUsersWithRolesCache();
		for (let listener of user_listeners) listener();
	} catch (err) {
		hdb_logger.error(err);
	}
}

userHandler.addListener = function (listener) {
	user_listeners.push(listener);
};
module.exports = server_itc_handlers;
