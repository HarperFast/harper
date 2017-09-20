const Socket_Server = require('./Socket_Server'),
    Socket_Client = require('./Socket_Client');


class ClusterServer {
    constructor(node) {
        this.socket_server = new Socket_Server(node);
        this.socket_client = new Socket_Client(node);


    }

    init(next){
        this.socket_server.init(next);
    }

    establishConnections(next){
        this.socket_client.establishConnections(next);
    }



    send(msg, res){
        this.socket_server.send(msg, res);
    }














}


module.exports = ClusterServer;