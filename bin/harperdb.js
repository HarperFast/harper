const run = require('./run'),
      install = require('./install'),
      stop = require('./stop'),
     register = require('./register'),
     version = require('./version'),
     fs = require('fs');

haperDBService();
function haperDBService(){
    let service;

    let currentDir_tokens = process.cwd().split('/');
    if(currentDir_tokens[currentDir_tokens.length -1] != 'bin'){
        return console.error('You must run harperdb from HDB_HOME/bin');
    }


    inBin = false;
    fs.readdir(process.cwd(), (err, files) => {
       if(err){
           return console.error(err);

       }

       for(f in files){
           if(files[f] == 'harperdb.js'){
               inBin = true;
           }
       }

        if(!inBin){
           return console.error('You must run harperdb from HDB_HOME/bin');
        }
            if(process.argv && process.argv[2]){
                service = process.argv[2].toLowerCase();
            }
            switch(service){
                case "run":

                    run.run();
                    break;
                case "install":

                    install.install();
                    break;
                case "register":
                    register.register();
                    break;
                case "stop":
                    stop.stop();
                    break;
                case "restart":
                    stop.stop(function(){
                        run.run();
                    });
                    break;
                case "version":
                    version.version();
                    break;
                default:

                    run.run();
                    break
            }



    });


}