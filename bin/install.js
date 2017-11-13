const installer = require('../utility/install/installer');

function install (callback) {
    installer.install(function(err, result) {
        if(err) {
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