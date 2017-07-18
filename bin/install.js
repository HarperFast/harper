const installer = require('../utility/install/installer');

function install (){
    installer.install(function(err, result){
        if(err){
            winston.error(err);
            return;
        }

    });
}
module.exports = {
    install: install
}