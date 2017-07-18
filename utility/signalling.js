const child = require('child_process'),
    global_schema = require('../utility/globalSchema');

module.exports = {
    signalSchemaChange
};

function signalSchemaChange(message){
    if (process.send === undefined) {
        global_schema.schemaSignal();
    } else {
        process.send(message);
    }
}