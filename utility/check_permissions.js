module.exports = {
    checkPermission: checkPermission,


}

const os = require("os");


function checkPermission (callback){
    const PropertiesReader = require('properties-reader');
    let hdb_boot_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
    let hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));

    if(os.userInfo().username != hdb_boot_properties.get('install_user')){
        return callback(`Error: Must execute as ${hdb_boot_properties.get('install_user')}`);

    }else{
        return callback();

    }
}
