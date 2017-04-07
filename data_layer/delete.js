const fs = require('fs')
    ,validate = require('validate.js')
    ,settings = require('settings')
    , exec = require('child_process').exec
    ,delete_validator = require('../validation/deleteValidator')


module.exports ={
  delete: function(delete_object, callback){
      validation = delete_validator(delete_object);
      if(validation){
          callback(validation);
          return;
      }

          var cmd = 'cd ' + settings.HDB_ROOT +'/schema/' + delete_object.schema + '/' + delete_object.table+  ';';
            cmd += 'rm */__hdb_hash/'+delete_object.hash_value+'.hdb;'
            cmd += 'rm ' + delete_object.hash_attribute + '/' + delete_object.hash_value + ' -r -f ';
          console.log(cmd)
          console.log(cmd);
          exec(cmd, function (error, stdout, stderr) {
                if(stderr){
                    console.error(error);
                    callback('delete failed');
                    return;
                }

                callback(null, delete_object.hash_value + ' successfully deleted');
          });








  }

};