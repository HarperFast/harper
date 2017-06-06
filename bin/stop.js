const spawn = require('child_process').spawn,

    winston = require('winston');


stop();
function stop(){

    var terminal = spawn('bash');
    terminal.stderr.on('data', function (data) {
        winston.log('error',`Express server failed to run: ${data}`);
        console.log('|------------- HarperDB successfully stopped ------------|');
        //Here is where the error output goes
    });

    terminal.stdout.on('data', function(data){
        winston.log('info', `Express Server stoped`);
    });

    terminal.stdin.write(`../node_modules/pm2/bin/pm2 stop hdb_express; ../node_modules/pm2/bin/pm2 stop hdb_schema_triggers; `);
    terminal.stdin.end();




}



