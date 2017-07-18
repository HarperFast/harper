const run = require('./run');

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
           const install = require('./install');
            install.install();
            break;
        case "register":
            const register = require('./register');
            register.register();
            break;
        case "stop":
            const stop = require('./stop');
            stop.stop();
            break;
        default:

            run.run();
            break
    }
}