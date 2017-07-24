const child = require('child_process'),
    global_schema = require('../utility/globalSchema'),
    winston = require('../utility/logging/winston_logger');

module.exports = {
    signalSchemaChange
};

function signalSchemaChange(message){
    if (process.send === undefined) {
        global_schema.schemaSignal((err)=>{
            if(err){
                winston.error(err);
            }
        });
    } else {
        process.send(message);
    }
}