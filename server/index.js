#!/usr/bin/env node
'use strict';

// importing Server class
const Server = require('./../lib/server/Server'),
    insert_server = require('./../lib/server/insertServer');


var server = new Server();

// Starting our server
server.start(insert_server, () => {
    console.log(`Server started`);
});