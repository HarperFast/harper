const os = require("os");
const env = require('../utility/environment/environmentManager');

module.exports = {
    checkPermission: checkPermission,
};

function checkPermission () {
    if(os.userInfo().username !== env.get('install_user')){
        throw new Error(`Error: Must execute as ${env.get('install_user')}`);
    }
}
