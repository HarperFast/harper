installer = require('./installer');
installer.install(function(err, result){
   if(err){
       console.error(error);
       return;
   }
   console.log(result);
});