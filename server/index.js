#!/usr/bin/env node
'use strict';

// importing Server class
const Server = require('./../lib/server/Server'),
    tcp_server = require('./../lib/server/tcp_server');


var server = new Server();

// Starting our server
server.start(tcp_server, () => {
    console.log(`Server started`);
});