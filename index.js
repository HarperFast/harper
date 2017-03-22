#!/usr/bin/env node
'use strict';

// importing Server class
const Server = require('./server/Server');


var server = new Server();

// Starting our server
server.start(() => {
    console.log(`Server started`);
});