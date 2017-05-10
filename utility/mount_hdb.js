/***
 * @Author: Stephen Goldberg
 * @Date: 3/4/3017
 * @Description: Used to mount the HarperDB filesystem within the project for testing and dev. 
 *
 *
 */

const fs = require('fs'),
    path = require('path');
var settings = require('settings');

function mount(hdb_path){
    function makeDirectory(cur_path) {
        if (fs.existsSync(cur_path)) {
            return;
        }

        fs.mkdirSync(cur_path);
        return;

    }
    if(fs.existsSync(hdb_path)){
        makeDirectory(path.join(hdb_path, "staging"));
        makeDirectory(path.join(hdb_path, "staging/scripts"));
        makeDirectory(path.join(hdb_path, "staging/symlink_eraser"));
        makeDirectory(path.join(hdb_path, "backup"));
        makeDirectory(path.join(hdb_path, "log"));
        makeDirectory(path.join(hdb_path, "config"));
        makeDirectory(path.join(hdb_path, "doc"));
        makeDirectory(path.join(hdb_path, "schema"));
        makeDirectory(path.join(hdb_path, "schema/system"));
        makeDirectory(path.join(hdb_path, "schema/system/hdb_attribute"));
        makeDirectory(path.join(hdb_path, "schema/system/hdb_schema"));
        makeDirectory(path.join(hdb_path, "schema/system/hdb_table"));
        makeDirectory(path.join(hdb_path, "schema/system/hdb_table/schema"));
        makeDirectory(path.join(hdb_path, "schema/system/hdb_table/name"));
        makeDirectory(path.join(hdb_path, "schema/system/hdb_table/hash_attribute"));
        makeDirectory(path.join(hdb_path, "schema/system/hdb_user"));
        makeDirectory(path.join(hdb_path, "schema/system/name_index"));
    }


}


mount(settings.HDB_ROOT);




