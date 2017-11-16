const installer = require('../utility/install/installer');

function install (callback) {
    installer.install(function(err, result) {
        if(err) {
            if(err === 'REFUSED') {
                console.log("Terms & Conditions refused, closing installer.");
                return callback(err, null);
            }
            console.log("There was an error during the install.  Please check the install logs. \n ERROR: " + err);
            winston.error(err)
            callback(err, result);
        }
        callback(null, "Installation successful");
    });
}
module.exports = {
    install: install
}