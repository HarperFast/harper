const registerationHandler = require('../utility/registrationHandler');
const logger = require('../utility/logging/harper_logger');

function register() {
    registerationHandler.register(null, function (err, result) {
        if (err) {
            logger.error(err);
            return;
        }

        console.log(result);
        return;
    });
}

module.exports = {
    register: register
}
