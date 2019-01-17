const installer = require('../utility/install/installer');
const logger = require('../utility/logging/harper_logger');
const Pool = require('threads').Pool;

function install (callback) {
    global.hdb_pool = new Pool();
    installer.install(function(err) {
        try {
            global.hdb_pool.killAll();
        } catch(e){
            logger.error(e);
        }
        if(err) {
            if(err === 'REFUSED') {
                console.log("Terms & Conditions refused, closing installer.");
                return callback(err, null);
            }
            console.log("There was an error during the install.  Please check the install logs. \n ERROR: " + err);
            logger.error(err);
            return callback(err);
        }

        callback(null, "Installation successful");
    });
}
module.exports = {
    install: install
}