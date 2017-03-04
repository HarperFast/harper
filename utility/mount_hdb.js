/***
 * @Author: Stephen Goldberg
 * @Date: 3/4/3017
 * @Description: Used to mount the HarperDB filesystem within the project for testing and dev. 
 *
 *
 */

const fs = require('fs');
var settings = require('settings');

function mount(path){
    function makeDirectory(cur_path) {
        if (fs.existsSync(cur_path)) {
            return;
        }

        fs.mkdirSync(cur_path);
        return;

    }
    if(fs.existsSync(path)){
        makeDirectory(path + "hdb");
        makeDirectory(path + "hdb/backup");
        makeDirectory(path + "hdb/log");
        makeDirectory(path + "hdb/config");
        makeDirectory(path + "hdb/doc");
        makeDirectory(path + "hdb/schema");
        makeDirectory(path + "hdb/schema/system");
        makeDirectory(path + "hdb/schema/system/hdb_attribute");
        makeDirectory(path + "hdb/schema/system/hdb_schema");
        makeDirectory(path + "hdb/schema/system/hdb_table");
        makeDirectory(path + "hdb/schema/system/hdb_user");
        makeDirectory(path + "hdb/schema/system/name_index");
    }


}


mount(settings.HDB_ROOT);




