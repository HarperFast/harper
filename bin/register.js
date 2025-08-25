'use strict';

const registrationHandler = require('../utility/registration/registrationHandler.js');
const hdbLogger = require('../utility/logging/harper_logger.js');

const REG_FAILED_MSG = 'Registration failed.';

async function register() {
	let result;
	try {
		result = await registrationHandler.register();
	} catch (err) {
		hdbLogger.error(`Registration error ${err}`);
		return REG_FAILED_MSG;
	}

	if (!result) {
		return REG_FAILED_MSG;
	}

	return result;
}

module.exports = {
	register,
};
