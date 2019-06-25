const SocketConnector = require('./SocketConnector');
const fs = require('fs-extra');
const env = require('../../../utility/environment/environmentManager');
env.initSync();
const hdb_config_path = env.getHdbBasePath() + '/config/';

class InterNodeSocketConnector extends SocketConnector{
    constructor(socket_client, additional_info, options, credentials){
        super(socket_client, additional_info, options, credentials);
        this.addEventListener('connect', this.connectHandler.bind(this));

        this.connection_timestamp = 0;

        setInterval(this.recordConnection.bind(this), 10000);
    }

    recordConnection(){
        if(this.socket.state === this.socket.OPEN && this.socket.authState === this.socket.AUTHENTICATED){
            this.connection_timestamp = Date.now();
            fs.writeFile(hdb_config_path + this.socket.additional_info.name, this.connection_timestamp).then(()=>{
                console.log('logged');
            });
        }
    }

    connectHandler(status){
        //TODO perform catchup call here
        this.recordConnection();
    }

}

module.exports = InterNodeSocketConnector;