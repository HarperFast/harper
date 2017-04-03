const spawn = require('child_process').spawn,
    settings = require('settings');

function callAWK(callback){
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
        callback(stderr_data, stdout_data);
    });

    var files = ['first_name/*/*'];
    var cd_path = `${settings.HDB_ROOT}/schema/dev/person`;
    terminal.stdin.write(`${settings.PROJECT_DIR}/bash/awkTest.sh ${cd_path} ${files.join(' ')}`);
    terminal.stdin.end();
}

function parseData(){

}

console.time('awk');
callAWK(function(err, data){
    //var data_array = data.split("\n~hdb~\n");
    var data_array = data.split("\n");
    console.log(data_array);
    if(err){
        console.error(err);
    }
    console.timeEnd('awk');
});

