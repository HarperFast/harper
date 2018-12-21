"use strict";

const log = require('../../utility/logging/harper_logger');
const schema = require('../../data_layer/schema');
const http = require('http');
const https = require('https');
const sio = require('socket.io');
const {promisify} = require('util');
const fs = require('fs');
const terms = require('../../utility/hdbTerms');
const SocketClient = require('./SocketClient');
const cluster_handlers = require('./clusterHandlers');
const {inspect} = require('util');

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
                    try {
                        let raw_remote_ip = socket.conn.remoteAddress;
                        let raw_remote_ip_array = raw_remote_ip ? raw_remote_ip.split(':') : [];
                        msg.host = Array.isArray(raw_remote_ip_array) && raw_remote_ip_array.length > 0 ?  raw_remote_ip_array[raw_remote_ip_array.length - 1] : '';
                        let new_client = new SocketClient(node, msg, terms.CLUSTER_CONNECTION_DIRECTION_ENUM.INBOUND);
                        new_client.client = socket;
                        new_client.createClientMessageHandlers();

                        let found_client = undefined;
                        if(global.cluster_server.socket_client) {
                            found_client = global.cluster_server.socket_client.filter((client) => {
                                return client.other_node.host === msg.host && client.other_node.port === msg.port;
                            });
                        }
                        //log.info(`**** found client results = ${inspect(found_client)}`);
                        //log.info(`**** Cluster socket client currently: ${inspect(global.cluster_server.socket_client)}`);
                        if(!found_client) {
                            log.error('didnt find a client');
                        } else {
                            log.error('found a client.');
                        }
                        // if we do not have a client connection for this other node we need to ask it for what we may have missed since last connection
                        let catchup_request = true;
                        for(let k = 0; k < node.other_nodes.length; k++) {
                            if(node.other_nodes[k].name === msg.name) {
                                catchup_request = false;
                                return;
                            }
                        }
                        log.error('done with catchup request');
                        if(catchup_request) {
                            socket.emit('catchup_request', {name: node.name});
                        }

                        log.error('done emitting catchup request');
                        if (!found_client || found_client.length === 0) {
                            log.error('cluster server push');
                            global.cluster_server.socket_client.push(new_client);
                            log.error('after cluster server push');
                        } else {
                            // This client already exists and is connected, this means we are establishing a bidirectional connection.
                            // We probably should never return more than 1, but set them all just in case.
                            log.error('in found client code');
                            log.error(`found client length: ${found_client.length}`);
                            if (found_client.length > 1) {
                                log.warn(`Multiple socket clients with the same host: ${found_client[0].host} and port: ${found_client[0].port} were found`);
                            }
                            for (let client of found_client) {
                                log.info(`Setting BIDIRECTIONAL connection for ${client.host}`);
                                client.direction = terms.CLUSTER_CONNECTION_DIRECTION_ENUM.BIDIRECTIONAL;
                            }
                        }
                    } catch(err) {
                        log.error(err);
                    }

                    socket.join(msg.name, async () => {
                        log.info(node.name + ' joined room ' + msg.name);
                        // retrieve the queue and send to this node.
                        await cluster_handlers.fetchQueue(msg, socket)
                    });
                });

                socket.on('catchup_request', async msg => {
                    log.info(msg.name + ' catchup_request');
                    await cluster_handlers.fetchQueue(msg, socket);
                });

                socket.on('confirm_msg', async msg => {
                    await cluster_handlers.onConfirmMessageHandler(msg);
                });

                socket.on('error', error => {
                    log.error(error);
                });

                socket.on('disconnect', error => {
                    if (error !== 'transport close')
                        log.error(error);
                });

                socket.on('schema_update_request', async () => {
                    try {
                        let schema = await p_schema_describe_all({});
                        socket.emit('schema_update_response', schema);
                    } catch(e){
                        log.error(e);
                    }
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