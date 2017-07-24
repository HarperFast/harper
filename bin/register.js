const registerationHandler = require('../utility/registrationHandler');

function register() {
    registerationHandler.register(null, function (err, result) {
        if (err) {
            winston.error(err);
            return;
        }

        console.log(result);
        return;

    });
}

module.exports = {
    register: register
}
