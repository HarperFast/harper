'use strict';

const hdbLogger = require('../../utility/logging/harper_logger.js');
const hdbTerms = require('../../utility/hdbTerms.ts');
const cleanLmdbMap = require('../../utility/lmdb/cleanLMDBMap.js');
const globalSchema = require('../../utility/globalSchema.js');
const schemaDescribe = require('../../dataLayer/schemaDescribe.js');
const userSchema = require('../../security/user.js');
const { validateEvent } = require('../threads/itc.js');
const harperBridge = require('../../dataLayer/harperBridge/harperBridge.js');
const process = require('process');
const { resetDatabases } = require('../../resources/databases.ts');

/**
 * This object/functions are passed to the ITC client instance and dynamically added as event handlers.
 * @type {{schema: ((function(*): Promise<void>)|*), job: ((function(*): Promise<void>)|*), user: ((function(): Promise<void>)|*)}}
 */
const serverItcHandlers = {
	[hdbTerms.ITC_EVENT_TYPES.SCHEMA]: schemaHandler,
	[hdbTerms.ITC_EVENT_TYPES.USER]: userHandler,
};

/**
 * Updates the global hdbSchema object.
 * @param event
 * @returns {Promise<void>}
 */
async function schemaHandler(event) {
	const validate = validateEvent(event);
	if (validate) {
		hdbLogger.error(validate);
		return;
	}

	hdbLogger.trace(`ITC schemaHandler received schema event:`, event);
	await cleanLmdbMap(event.message);
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
		harperBridge.resetReadTxn(hdbTerms.SYSTEM_SCHEMA_NAME, hdbTerms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME);
		harperBridge.resetReadTxn(hdbTerms.SYSTEM_SCHEMA_NAME, hdbTerms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME);
		harperBridge.resetReadTxn(hdbTerms.SYSTEM_SCHEMA_NAME, hdbTerms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME);
		// TODO: Eventually should indicate which database/table changed so we don't have to scan everything
		let databases = resetDatabases();
		if (msg.table && msg.database)
			// wait for a write to finish to ensure all writes have been written
			await databases[msg.database][msg.table].put(Symbol.for('write-verify'), null);
	} catch (e) {
		hdbLogger.error(e);
	}
}

function handleErrorCallback(err) {
	if (err) {
		hdbLogger.error(err);
	}
}

const userListeners = [];
/**
 * Updates the global hdbUsers object by querying the hdbRole table.
 * @param event
 * @returns {Promise<void>}
 */
async function userHandler(event) {
	try {
		try {
			harperBridge.resetReadTxn(hdbTerms.SYSTEM_SCHEMA_NAME, hdbTerms.SYSTEM_TABLE_NAMES.USER_TABLE_NAME);
			harperBridge.resetReadTxn(hdbTerms.SYSTEM_SCHEMA_NAME, hdbTerms.SYSTEM_TABLE_NAMES.ROLE_TABLE_NAME);
		} catch (error) {
			// this can happen during tests, best to ignore
			hdbLogger.warn(error);
		}
		const validate = validateEvent(event);
		if (validate) {
			hdbLogger.error(validate);
			return;
		}

		hdbLogger.trace(`ITC userHandler ${hdbTerms.HDB_ITC_CLIENT_PREFIX}${process.pid} received user event:`, event);
		await userSchema.setUsersWithRolesCache();
		for (let listener of userListeners) listener();
	} catch (err) {
		hdbLogger.error(err);
	}
}

userHandler.addListener = function (listener) {
	userListeners.push(listener);
};
module.exports = serverItcHandlers;
