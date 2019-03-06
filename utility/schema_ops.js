'use strict';

const fs = require('graceful-fs');
const uuidV4 = require('uuid/v4');
const env = require('../utility/environment/environmentManager');

module.exports = {
    addToQueue: addToQueue,
    addToLog: addToLog,
    checkQueue: checkQueue
};
function addToQueue(ops_object, callback){

    let id = uuidV4();
    fs.writeFile(`${env.get('HDB_ROOT')}/staging/schema_op_queue/${id}.hdb`,
        JSON.stringify(ops_object), (err) => {
            if (err) {
                return callback(err);
            }
            return callback(null, id);
        });
}

function addToLog(id, callback){
    try{
        fs.createReadStream(`${env.get('HDB_ROOT')}/staging/schema_op_queue/${id}.hdb`)
            .pipe(fs.createWriteStream(`${env.get('HDB_ROOT')}/staging/schema_op_log/${id}.hdb`));
        return callback(null, id);
    }catch(e){
        return callback(e);
    }
}

function checkQueue(){

}
