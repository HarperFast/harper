const harper_logger = require('../../utility/logging/harper_logger');
const auth = require('../../security/auth');
const server_utilities = require('../serverUtilities');

module.exports = {
    onMessageHandler: onMessageHandler
};

function onMessageHandler(node, socket, msg){
    try {
        let the_client = socket;
        let this_node = node;

        harper_logger.info(`received by ${this_node.name} : msg = ${JSON.stringify(msg)}`);

        authHeaderToUser(msg.body, (error) => {
            if (error) {
                return harper_logger.error(error);
            }

            if (!msg.body.hdb_user) {
                harper_logger.info('there is no hdb_user: ' + JSON.stringify(msg.body));
            }

            server_utilities.chooseOperation(msg.body, (err, operation_function) => {
                server_utilities.proccessDelegatedTransaction(msg.body, operation_function, function (err, data) {
                    let payload = {
                        "id": msg.id,
                        "error": err,
                        "data": data,
                        "node": this_node
                    };
                    the_client.emit('confirm_msg', payload);
                });
            });
        });
    } catch(e){
        harper_logger.error(e);
    }
}

function authHeaderToUser(json_body, callback){
    let req = {};
    req.headers = {};
    req.headers.authorization = json_body.hdb_auth_header;

    auth.authorize(req, null, function (err, user) {
        if (err) {
            return callback(err);
        }

        json_body.hdb_user = user;

        callback(null, json_body);
    });
}