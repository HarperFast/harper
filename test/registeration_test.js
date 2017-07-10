register = require('../register');

test();

function test(){
    register.registe(function(err, result){
        if(err) {
            winston.error(err);
            return;
        }
        winston.info(result);
        return;


    });



}



