const registrationHandler = require('../utility/registration/registrationHandler');
const logger = require('../utility/logging/harper_logger');
const Pool = require('threads').Pool;

async function register() {
    try {
        let result = await registrationHandler.register().catch((err) => {
            return logger.error(`Registration error ${err}`);
        });

        if (!result) {
            return (`Registration failed.`);
        }
        return (`Registration result: ${result}`);
    } catch (e) {
        logger.error(e);
    }
}

module.exports = {
    register: register
};
