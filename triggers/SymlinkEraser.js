'use strict';
const fs = require('fs')
    , settings = require('settings');
var port = settings.ERASER_PORT;

function initalize(){
    net.createServer(conn).listen(port, settings.HDB_ADDRESS).on('error', (error)=>{
        winston.log('error',`TCP fail: ${error}`);
    });

}


function conn(socket) {
    socket.setEncoding('utf8');
    let socket_data = '';
    console.log('connected');
    socket.on('error', (err) => {
        winston.log('error',`Socket ${client.name} fail: ${err}`);
    });

    socket.on('close', (err) => {
        //console.log(`Socket ${client.name} disconnected`);
    });

    socket.on('data', onSocketData);

    function onSocketData(data) {
        if(!isJson(data)){
            winston.log('error',`Eraser recieved ${data} fail`);

        }

        fs.readFile(settings.HDB_ROOT + '/staging/symlink_eraser/link_log.hdb' , (err, log_file) => {
            var new_file_content = log_file + data;
            fs.writeFile(settings.HDB_ROOT + '/staging/symlink_eraser/link_log.hdb', new_file_content, (err) => {
                if (err){
                    winston.log('error',`Eraser failed to update with ${data}`);
                }
            });

        });



    }




    function isJson(string) {
        try {
            JSON.parse(string);
        } catch (e) {
            return false;
        }
        return true;
    }
}


