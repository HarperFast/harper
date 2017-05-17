'use strict';
const fs = require('fs')
    , settings = require('settings'),
    net = require('net'),
    schedule = require('node-schedule'),
    winston=require('winston');


var port = settings.ERASER_PORT;

function initalize(){
    net.createServer(conn).listen(port, settings.HDB_ADDRESS).on('error', (error)=>{
        winston.log('error',`TCP fail: ${error}`);
    });

    cron_cleanup();

}

function cron_cleanup(){


    var job = schedule.scheduleJob('*/1 * * * *', function(){
        fs.readdir(settings.HDB_ROOT + '/staging/symlink_eraser/', (err, log_files) =>{
            for(var file in log_files){
                cleanUpLinks(log_files[file]);
            }

        });

    });
}

function cleanUpLinks(file_path){
    fs.readFile(`${settings.HDB_ROOT}/staging/symlink_eraser/${file_path}` , (err, log_file) => {
        if(!err){
            const globby = require('globby');
            console.time('glob');
            var globs = [];
            var updates = JSON.parse(log_file);
            var table = updates[0].write.table;
            var schema = updates[0].write.schema;
            var hash_attribute = updates[0].write.hash_attribute;
            for(var item in updates){

                for(var r in updates[item].write.records){
                   // globs.push(`${updates[item].write.records[item][hash_attribute]}/${updates[item].write.records[item][hash_attribute]}-*.hdb`)
                    globs.push(`*/*/${updates[item].write.records[r][hash_attribute]}.hdb`)
                }
            }

            globs.push('!__hdb_hash/*/*');

            globby(globs, {cwd: `${settings.HDB_ROOT}/schema/${schema}/${table}/`}).then(paths => {
                console.timeEnd('glob');
                console.log(paths);
            });
        }

    });
}


function conn(socket) {
    socket.setEncoding('utf8');
    let socket_data = '';
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
        var obj = JSON.parse(data);
        fs.readFile(`${settings.HDB_ROOT}/staging/symlink_eraser/${obj.write.schema}_${obj.write.table}_link_log.hdb` , (err, log_file) => {
           var log_array = [];
            if(log_file){
                log_array = JSON.parse(log_file);
            }
            log_array.push(JSON.parse(data));
            fs.writeFile(`${settings.HDB_ROOT}/staging/symlink_eraser/${obj.write.schema}_${obj.write.table}_link_log.hdb`, JSON.stringify(log_array), (err) => {
                if (err){
                    winston.log('error',`Eraser failed to update with ${data} error: ${err}`);
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

initalize();
