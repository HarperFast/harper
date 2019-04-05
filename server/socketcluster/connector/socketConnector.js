'use strict';

module.exports={
    init: init
};

function init(socket_client, hostname, port, credentials) {
    let socket = socket_client.create({
        hostname: hostname,
        port: port,
        rejectUnauthorized: false, // Only necessary during debug if using a self-signed certificate
        autoConnect:true,
        connectTimeout: 10000, //milliseconds
        ackTimeout: 10000, //milliseconds
        autoReconnectOptions: {
            initialDelay: 1000, //milliseconds
            randomness: 5000, //milliseconds
            multiplier: 1.5, //decimal
            maxDelay: 30000 //milliseconds
        }
    });

    socket.on('incoming_data', (data, res)=>{
        console.log(data);
    });

    socket.on('error', err =>{
        console.error(err);
    });

    socket.on('connect', status =>{
        console.log(status);
    });

    socket.on('login', (data, res)=>{
        res(null, credentials);
    });

    socket.on('authStateChange', state_change_data =>{
        console.log(state_change_data);
    });

    return socket;
}