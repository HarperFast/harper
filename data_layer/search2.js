const spawn = require('child_process').spawn,
    settings = require('settings'),
    async = require('async'),
    fs = require('fs'),
    path=require('path');

function callAWK(callback){
    console.time('awk');
    var terminal = spawn('bash');

    var stdout_data = '';
    var stderr_data = '';
    terminal.stdout.on('data', function (data) {
        stdout_data += data.toString();
    });

    terminal.stderr.on('data', function (data) {
        stderr_data += data.toString();
    });

    terminal.on('exit', function (code) {
        console.timeEnd('awk');
        callback(stderr_data, stdout_data);
    });

    //var files = ['first_name/*/*'];
    var table_path = `${settings.HDB_ROOT}/schema/dev/person/`;
    var staging_path = `${settings.HDB_ROOT}/staging/search/dev/person/`;
    terminal.stdin.write(`bash ${settings.PROJECT_DIR}/bash/search.sh ${table_path} ${staging_path} first_name A* A first_name,last_name`);
    terminal.stdin.end();
}

function parseData(data_blob){
    let data_array = [];
    let data_keys = Object.keys(data_blob);
    let source_object = data_blob[data_keys[0]];

    Object.keys(source_object).forEach(function(key){
        let data_object = {};

        data_keys.forEach(function(attribute){
            data_object[attribute] = data_blob[attribute][key];
        });
        data_array.push(data_object);
    });
    return data_array;
    //console.log(data_array);
}


callAWK(function(err, data){
    //var data_array = data.split("\n~hdb~\n");
    var data_array = data.split("\n");
    //console.log(data_array);
    var file_data = {};
    if(err){
        console.error(err);
    } else {

        async.each(data_array, function(file, callback){
            if(!file) {
                callback();
                return;
            }

            fs.readFile(file, (err, data) => {
                if (err) {
                    callback(err);
                    return;
                }
                let attribute = path.basename(file, '.txt').split('.')[0];
                file_data[attribute] = JSON.parse(`{${data.toString().replace(/,$/, "")}}`);
                callback(null, null);
            });
        }, function(err){
            //console.log(file_data);
            return parseData(file_data);
        });
    }

});

