installer = require('./installer');
installer.install(function(err, result){
   if(err){
       console.error(err);
       return;
   }
   console.log(result);
});