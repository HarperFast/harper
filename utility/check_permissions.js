const os = require("os");
const PropertiesReader = require('properties-reader');

module.exports = {
    checkPermission: checkPermission,
};

function checkPermission () {
    let hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);

    if(os.userInfo().username != hdb_boot_properties.get('install_user')){
        throw new Error(`Error: Must execute as ${hdb_boot_properties.get('install_user')}`);
    }
}
