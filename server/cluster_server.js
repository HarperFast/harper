const  search = require('../data_layer/search'),
    winston = require('../utility/logging/winston_logger'),
    server_utilities = require('./server_utilities');
var PropertiesReader = require('properties-reader'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));



module.exports = {
    initialze:initialize,
    proccess: proccess

}

var this_io = require("socket.io").listen(hdb_properties.get("CLUSTER_PORT"));
var other_io = [];
var this_nsp = null;
var this_socket = null;

function initialize(){


    let search_nodes = {
        "table":"hdb_nodes",
        "schema":"system",
        "hash_attribute":"name",
        "search_attribute":"name",
        "search_value":"*",
        "get_attributes":["*"]
    }

    search.searchByValue(search_nodes, function(err, nodes){
        for(n in nodes){
            if(nodes[n].name != hdb_properties.get('NODE_NAME')){
                let other_node = require("socket.io-client")(`${nodes[n].host}:${nodes[n].port}`); // This is a client connecting to the SERVER 2

                other_node.on("connect",function(){
                    other_node.on('message',function(data){
                        // We received a message from Server 2
                        // We are going to forward/broadcast that message to the "Lobby" room
                        winston.info('operation', data);
                    });
                });

                other_io.push(other_node);

            }

        }

       this_nsp = this_io.of('/' + hdb_properties.get('NODE_NAME'));
        this_nsp.sockets.on("connection",function(socket){
            this_socket = socket;
            // Display a connected message
            console.log("User-Client Connected!");

            // Lets force this connection into the lobby room.
            socket.join('lobby');

            // Some roster/user management logic to track them
            // This would be upto you to add :)

            // When we receive a message...
            socket.on("message",function(data){
                try {
                    server_utilities.chooseOperation(data, function(err, operation_function){
                        operation_function(req.body, (error, data) => {
                            if (error) {
                                winston.info(error);
                                if(typeof error != 'object')
                                    error = {"error": error};
                                // tell the socket this came from it failed.
                                return;
                            }
                            if(typeof data != 'object')
                                data = {"message": data};
                            // send data to socket
                            return
                        });

                    });


                } catch (e) {
                    winston.error(e);
                    // send error to socket
                    return
                }
            });

            socket.on("disconnect",function(data){
                for(n in other_io){
                    other_io[n].emit("message", "UD," + socket.id);
                }

            });
        });

    });


}

function proccess(req, node_names){
    let emit_to_nodes = JSON.parse(node_names);
    for(n in emit_to_nodes){
        this_socket.to(emit_to_nodes[n]).emit(req);

    }
}