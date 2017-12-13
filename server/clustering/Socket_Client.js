const server_utilities = require('../server_utilities'),
    winston = require('../../utility/logging/winston_logger'),
    retry = require('retry-as-promised'),
    ioc = require('socket.io-client');



class Socket_Client{
    constructor(node) {
        this.node = node;

    }

    establishConnections(next) {
        try {
            const async = require('async');

            let node = this.node;

            async.each(node.other_nodes, function (o_node, caller) {
                global.cluster_server.connectToNode(node, o_node, function(err){
                    if(err){
                        next(err);
                    }

                });


            }, function (err) {
                next();
            });
        }catch(e){
            winston.error(e);
            next(e)
        }
    }


    connectToNode(node, o_node, callback){
        if(node.port == o_node.port && o_node.host == node.host ){
            callback("cannnot connect to thyself. ");
        }
        //TODO needs to be HTTPS
        winston.info(`${node.name} is attempting to connect to ${o_node.name} at ${o_node.host}:${o_node.port}`);
        var client =  ioc.connect(`http://${o_node.host}:${o_node.port}`);

        client.on("connect", function () {
            o_node.status = 'connected';
            global.o_nodes[o_node.name] = o_node;

            winston.info('Client: Connected to port ' + o_node.port);
            client.emit('identify', node.name);

        });

        client.on('connect_error', (error) => {
           /** winston.error(error);
            o_node.status = 'disconnected';
            global.o_nodes[o_node.name] = o_node;
            winston.warn(`failed to connect to ${o_node.name}`);
            callback(error); **/

        });

        client.on('catchup', function(queue_string){
            winston.info('catchup' + queue_string);
            let queue = JSON.parse(queue_string);
            for(let item in queue){
                server_utilities.chooseOperation(queue[item].msg, function(err, operation_function){
                    if(err){
                        return winston.error(err);
                    }

                    server_utilities.proccessDelegatedTransaction(queue[item].msg,
                        operation_function, function(err, result){
                        if(err){
                            client.emit('error', err);
                            return winston.error(err);
                        }
                        queue[item].node = global.cluster_server.socket_server.node;
                        client.emit('confirm_msg', queue[item]);
                    });
                });

            }
        });


        client.on('confirm_identity', function (msg) {

            callback();
        });

        client.on('msg', (msg, fn) => {

            winston.info(`recieved by ${node.name} : msg = ${JSON.stringify(msg)}`);
            server_utilities.chooseOperation(msg.msg, (err, operation_function) => {
                server_utilities.proccessDelegatedTransaction(msg.msg, operation_function, function (err, data) {
                    let payload = {
                        "id": msg.id,
                        "error": err,
                        "data": data
                    };


                    client.emit('confirm_msg', payload);
                });


            });


            //fn(name);
        });

        client.on('disconnect', function (reason) {
            o_node.status = 'disconnected';
            global.o_nodes[o_node.name] = o_node;
            winston.info(`server ${o_node.name} down`);
        });



    }


}





module.exports = Socket_Client;