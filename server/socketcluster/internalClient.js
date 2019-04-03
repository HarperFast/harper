'use strict';

const socketclient = require('socketcluster-client');
const env = require('../../utility/environment/environmentManager');
const PORT = env.get('CLUSTERING_PORT');
const DEFAULT_PORT = 1111;
module.exports={
    init: init
};

function init() {
    let socket = socketclient.connect({
        port: PORT ? PORT : DEFAULT_PORT
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
        //dummy credentials
        res(null, {username: 'kyle', password: 'test'});
    });

    socket.on('authStateChange', state_change_data =>{
        console.log(state_change_data);
    });

    global.hdb_socket_client = socket;
}