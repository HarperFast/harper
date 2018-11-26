const registrationHandler = require('../utility/registration/registrationHandler');
const logger = require('../utility/logging/harper_logger');

async function register() {
    let result = await registrationHandler.register().catch((err) => {
        return logger.error(`Registration error ${err}`);
    });
    if(!result) {
        return (`Registration failed.`);
    }
    return (`Registration result: ${result}`);
}

module.exports = {
    register: register
}
