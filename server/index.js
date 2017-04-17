#!/usr/bin/env node
'use strict';
    var method;
    if(process.argv && process.argv.length > 2){
        method =  process.argv[2];
    }

    console.log(method);
    var port;
    switch(method) {
        case 'write':
            port = 9925;
            break;
        case 'search':
            port = 9926;
            break;
        case 'delete':
            port = 9927;
            break;
        default:
            port = 9926;
    }


// importing Server class
    const Server = require('./../lib/server/Server'),
        tcp_server = require('./../lib/server/tcp_server');



    var server = new Server();

// Starting our server
    server.start(tcp_server,port, () => {
        console.log('Server started on port ' + port);
    });

