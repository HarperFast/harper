const child = require('child_process');

module.exports = {
    signalSchemaChange
};

function signalSchemaChange(message){
    if (process.send === undefined) {
        console.log('not a child process');
    } else {
        process.send(message);
    }
}