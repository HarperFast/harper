const run = require('./run'),
      install = require('./install'),
      stop = require('./stop'),
     register = require('./register');

haperDBService();
function haperDBService(){
    let service;
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
        default:

            run.run();
            break
    }
}