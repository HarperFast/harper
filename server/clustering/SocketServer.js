"use strict";

const log = require('../../utility/logging/harper_logger');
const search = require('../../data_layer/search');
const insert = require('../../data_layer/insert');
const delete_ = require('../../data_layer/delete');
const schema = require('../../data_layer/schema');
const uuidv4 = require('uuid/v1');
const http = require('http');
const https = require('https');
const sio = require('socket.io');
const {promisify} = require('util');
const fs = require('fs');
const terms = require('../../utility/hdbTerms');
const SocketClient = require('./SocketClient');
const cluster_handlers = require('./clusterHandlers');

const p_schema_describe_all = promisify(schema.describeAll);

const PropertiesReader = require('properties-reader');
let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));

const privateKeyPath = hdb_properties.get(terms.HDB_SETTINGS_NAMES.PRIVATE_KEY_KEY);
const certificatePath = hdb_properties.get(terms.HDB_SETTINGS_NAMES.CERT_KEY);

let credentials = undefined;
try {
    credentials = {key: fs.readFileSync(`${privateKeyPath}`), cert: fs.readFileSync(`${certificatePath}`)};
} catch(err) {
    log.error('Error reading https private key and credential files');
    credentials = undefined;
}

class SocketServer {
    constructor(node) {
        this.node = node;
        this.name = node.name;
        this.port = node.port;
        this.other_nodes = node.other_nodes;
        this.io = null;
        global.msg_queue = [];
        global.o_nodes = [];
        global.cluster_queue = {};
    }

    init(next) {
        try {
            let server = undefined;
            if(!credentials) {
                server = http.createServer().listen(this.port, function () {
                });
            } else {
                server = https.createServer(credentials, () => {

                }).listen(this.port);
            }
            let node = this.node;
            this.io = sio.listen(server);
            this.io.sockets.on("connection", function (socket) {
                socket.on("identify", function (msg, callback) {
                    //this is the remote ip address of the client connecting to this server.
                    let raw_remote_ip = socket.conn.remoteAddress;
                    let raw_remote_ip_array = raw_remote_ip ? raw_remote_ip.split(':') : [];
                    msg.host = Array.isArray(raw_remote_ip_array) && raw_remote_ip_array.length > 0 ?  raw_remote_ip_array[raw_remote_ip_array.length - 1] : '';
                    let new_client = new SocketClient(node, msg);
                    new_client.client = socket;
                    new_client.createClientMessageHandlers();

                    let found_client = global.cluster_server.socket_client.filter((client)=>{
                        return client.other_node.name === msg.name;
                    });

                    // if we do not have a client connection for this other node we need to ask it for what we may have missed since last connection
                    let catchup_request = true;
                    for(let k = 0; k < node.other_nodes.length; k++){
                        if(node.other_nodes[k].name === msg.name){
                            catchup_request = false;
                            return;
                        }
                    }

                    if(catchup_request){
                        socket.emit('catchup_request', {name: node.name});
                    }

                    if(!found_client || found_client.length === 0){
                        global.cluster_server.socket_client.push(new_client);
                    }

                    socket.join(msg.name, async () => {

                        harper_logger.info(node.name + ' joined room ' + msg.name);
                        // retrieve the queue and send to this node.
                        await cluster_handlers.fetchQueue(msg, socket)

                    });
                });

                socket.on('catchup_request', async msg => {
                    harper_logger.info(msg.name + ' catchup_request');
                    await cluster_handlers.fetchQueue(msg, socket);
                });



                socket.on('confirm_msg', async msg => {
                    await cluster_handlers.onConfirmMessageHandler(msg);
                });

                socket.on('error', error => {
                    harper_logger.error(error);
                });

                socket.on('disconnect', error => {
                    if (error !== 'transport close')
                        log.error(error);
                });

                socket.on('schema_update_request', async () => {
                    let schema = await p_schema_describe_all({})
                        .catch(err =>{
                            return harper_logger.error(err);
                        });
                    socket.emit('schema_update_response', schema);
                });


            });

            next();

        } catch (e) {
            log.error(e);
            next(e);
        }
    }
}

module.exports = SocketServer;