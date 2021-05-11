'use strict';

const registrationHandler = require('../utility/registration/registrationHandler');
const logger = require('../utility/logging/harper_logger');

const REG_FAILED_MSG = 'Registration failed.';

async function register() {
    let result;
    try {
        result = await registrationHandler.register();
    } catch(err) {
        logger.error(`Registration error ${err}`);
        return REG_FAILED_MSG;
    }

    if (!result) {
        return REG_FAILED_MSG;
    }

    return result;
}

module.exports = {
    register: register
};
