const server_utilities = require('../server_utilities'),
    winston = require('../../utility/logging/winston_logger');

class Socket_Client{
    constructor(node) {
        this.node = node;

    }

    establishConnections(next) {
        try {
            const async = require('async');

            let node = this.node;

            async.each(node.other_nodes, function (o_node, caller) {
                connectToNode(node, o_node, function(err){
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





}


var wait_time = 1500;
var timeOut = null

function connectToNode(node, o_node, callback){
    if(node.port == o_node.port && o_node.host == node.host ){
        callback("cannnot connect to thyself. ");
    }

    var ioc = require('socket.io-client');

    var connected = false;

    var client = ioc.connect(`http://${o_node.host}:${o_node.port}`);
    client.on("connect", function () {
        winston.info('Client: Connected to port ' + o_node.port);

        client.emit('identify', node.name);


    });
    if(timeOut){
        clearTimeout(timeOut)
    }
    timeOut = setTimeout(handleConnectionFail, wait_time);

    function handleConnectionFail(){
        if(!connected){
            setTimeout(connectToNode(node, o_node, callback), wait_time);
            if(wait_time < 10000){
                wait_time = wait_time * 2;
            }
        }

    }



    client.on('confirm_identity', function (msg) {
        connected = true;
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
        winston.info(`server ${o_node.name} down`);
    });
}

module.exports = Socket_Client;