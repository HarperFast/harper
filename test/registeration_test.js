register = require('../register');

test();

function test(){
    register.register(function(err, result){
        if(err) {
            console.error(err);
            return;
        }
        console.log(result);
        return;


    });



}



