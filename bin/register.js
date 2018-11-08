const registrationHandler = require('../utility/registration/registrationHandler');
const logger = require('../utility/logging/harper_logger');

async function register() {
    let result = await registrationHandler.register(null).catch((err) => {
        return logger.error(err);
    });
    return console.log(result);
}

module.exports = {
    register: register
}
