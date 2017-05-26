var mount = require('../utility/mount_hdb');
mount('/home/stephen/hdb', function(err, result){
   console.log(err);
   console.log(result);
});