const uuidv1 = require('uuid/v1'),
      winston = require('../../utility/logging/winston_logger');

class Socket_Server{
    constructor(node) {
        this.node = node;
        this.name = node.name;
        this.port = node.port;
        this.other_nodes = node.other_nodes;
        global.msg_queue = [];
        global.o_nodes = [];
        global.cluster_queue = [];


    }


    init(next) {
        try {


            // TODO probably need to make this https
            var server = require('http').createServer().listen(this.port, function () {
            });

            let node = this.node;
            this.io = require('socket.io').listen(server);

            this.io.sockets.on("connection", function (socket) {


                socket.on("identify", function (msg, callback) {
                    socket.join(msg, () => {

                        winston.info(node.name + ' joined room ' + msg);
                        // retrive the queue and send to this node.

                        socket.emit('confirm_identity');

                        if(global.cluster_queue
                            && global.cluster_queue[msg]){
                            winston.info('sent msg');
                            winston.info(global.cluster_queue[msg]);
                            let catchup_payload = JSON.stringify(global.cluster_queue[msg]);
                            socket.emit('catchup', catchup_payload);
                        }


                    });


                    // callback( msg );
                });

                socket.on('confirm_msg', function (msg) {
                    winston.info(msg);
                    if(global.msg_queue[msg.id]){
                        if(msg.error){
                            global.msg_queue[msg.id].status(200).json(msg.error);

                        }else if(msg.data){
                            global.msg_queue[msg.id].status(200).json(msg.data);

                        }

                        delete global.cluster_queue[msg.node.name][msg.id];

                    }

                    //this.queue[msg].recieved = true;
                });

                socket.on("msg", function (msg, callback) {

                    winston.info(`${this_node.name} says ${msg}`);
                    //callback( msg );
                });


                socket.on('error', function (error) {
                    winston.error(error);
                });

                socket.on('disconnect', function(error){
                   winston.error(err);

                });


            });

            next();
        }catch(e){
            winston.error(e);
            next(e);
        }
    }

    send(msg, res){
        try {
            let payload = {"msg": msg.msg, "id": uuidv1()};


            if(!global.cluster_queue[msg.node.name]){
                global.cluster_queue[msg.node.name] = {};
            }
            global.msg_queue[payload.id] = res;
            global.cluster_queue[msg.node.name][payload.id] = payload;
            // do I save these to disk now?
            // should I wait until I have several of them?
            this.io.to(msg.node.name).emit('msg', payload);
        }catch(e){
            //save the queue to disk for all nodes.
            winston.error(e);
        }
    }

}

module.exports = Socket_Server;