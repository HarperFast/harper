const installer = require('../utility/install/installer');

installer.install(function(err, result){
   if(err){
       winston.error(err);
       return;
   }

});