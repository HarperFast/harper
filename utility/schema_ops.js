'use strict';

const fs = require('graceful-fs'),
      uuidV4 = require('uuid/v4');
const PropertiesReader = require('properties-reader');

let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));


module.exports = {
    addToQueue: addToQueue,
    addToLog: addToLog,
    checkQueue: checkQueue
}
function addToQueue(ops_object, callback){

    let id = uuidV4();
    fs.writeFile(`${hdb_properties.get('HDB_ROOT')}/staging/schema_op_queue/${id}.hdb`,
        JSON.stringify(ops_object), (err) => {
            if (err) {
                return callback(err);

            }

            return callback(null, id);

        });


}

function addToLog(id, callback){
    try{
        fs.createReadStream(`${hdb_properties.get('HDB_ROOT')}/staging/schema_op_queue/${id}.hdb`)
            .pipe(fs.createWriteStream(`${hdb_properties.get('HDB_ROOT')}/staging/schema_op_log/${id}.hdb`));
        callback(null, id);
        return;
    }catch(e){
        callback(e);
        return;
    }



}

function checkQueue(){

}
