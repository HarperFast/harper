const registrationHandler = require('../utility/registration/registrationHandler');
const logger = require('../utility/logging/harper_logger');
const Pool = require('threads').Pool;

async function register() {
    try {
        global.hdb_pool = new Pool();
        let result = await registrationHandler.register().catch((err) => {
            global.hdb_pool.killAll();
            return logger.error(`Registration error ${err}`);
        });
        global.hdb_pool.killAll();
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
}
