const uuidv1 = require('uuid/v1'),
      winston = require('../../utility/logging/winston_logger');

class Socket_Server{
    constructor(node) {
        this.node = node;
        this.name = node.name;
        this.port = node.port;
        this.other_nodes = node.other_nodes;
        global.msg_queue = [];

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
                        socket.emit('confirm_identity');
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


            });

            next();
        }catch(e){
            winston.error(e);
            next(e);
        }
    }

    send(msg, res){
        try {
            winston.info('attempting to send msg');
            let payload = {"msg": msg.msg, "id": uuidv1()};

            global.msg_queue[payload.id] = res;
            // i need a way to hold the req and respond from here.
            this.io.to(msg.node.name).emit('msg', payload);
        }catch(e){
            winston.error(e);
        }
    }

}

module.exports = Socket_Server;