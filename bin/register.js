const registerationHandler = require('../utility/registrationHandler');

registerationHandler.register(null,function(err, result){
    if(err) {
        console.error(err);
        return;
    }

    console.log(result);
    return;

});
