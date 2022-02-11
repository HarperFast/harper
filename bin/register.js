'use strict';

const registrationHandler = require('../utility/registration/registrationHandler');
const hdb_logger = require('../utility/logging/harper_logger');
const hdb_terms = require('../utility/hdbTerms');

const REG_FAILED_MSG = 'Registration failed.';

async function register() {
	hdb_logger.createLogFile(hdb_terms.PROCESS_LOG_NAMES.CLI, hdb_terms.PROCESS_DESCRIPTORS.REGISTER);

	let result;
	try {
		result = await registrationHandler.register();
	} catch (err) {
		hdb_logger.error(`Registration error ${err}`);
		return REG_FAILED_MSG;
	}

	if (!result) {
		return REG_FAILED_MSG;
	}

	return result;
}

module.exports = {
	register: register,
};
