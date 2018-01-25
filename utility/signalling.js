const winston = require('../utility/logging/winston_logger');

module.exports = {
    signalSchemaChange,
    signalUserChange
};
const global_schema = require('../utility/globalSchema');

function signalSchemaChange(message){
    try {
        if (process.send === undefined) {
            global_schema.schemaSignal((err) => {
                if (err) {
                    winston.error(err);
                }
            });
        } else {
            process.send(message);
        }
    }catch(e){
        global_schema.schemaSignal((err) => {
            if (err) {
                winston.error(err);
            }
        });
    }
}

function signalUserChange(message){
    try {
        if (process.send === undefined) {
            winston.error('process.send in Signal User Change is undefined.');
        } else {
            process.send(message);
        }
    } catch(e){
        winston.error(e);
    }
}