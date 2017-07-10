var mount = require('../utility/mount_hdb');
mount('/home/stephen/hdb', function(err, result){
   winston.info(err);
   winston.info(result);
});