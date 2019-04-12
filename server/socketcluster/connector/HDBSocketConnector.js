const SocketConnector = require('./SocketConnector');

class HDBSocketConnector extends SocketConnector{
    constructor(socket_client, name, options, credentials){
        super(socket_client, name, options, credentials);
        this.addEventListener('authStateChange', this.registerWorker);
    }

    registerWorker(authStateChange){
        console.log(authStateChange);
        if(authStateChange.newState === 'authenticated'){
            this.emit('register_worker', {hdb_worker: process.pid});
        }
    }
}

module.exports = HDBSocketConnector;