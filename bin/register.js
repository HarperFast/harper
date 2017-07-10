const registerationHandler = require('../utility/registrationHandler');

registerationHandler.register(null,function(err, result){
    if(err) {
        winston.error(err);
        return;
    }

    console.log(result);
    return;

});
