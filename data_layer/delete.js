const fs = require('fs')
    , validate = require('validate.js'),
    PropertiesReader = require('properties-reader'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`),
    exec = require('child_process').exec
    delete_validator = require('../validation/deleteValidator');
    hdb_properties.append(hdb_properties.get('settings_path'));


module.exports ={
  delete: function(delete_object, callback){
      validation = delete_validator(delete_object);
      if(validation){
          callback(validation);
          return;
      }

          var cmd = 'cd ' + hdb_properties.get('HDB_ROOT') +'/schema/' + delete_object.schema + '/' + delete_object.table+  ';';
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
                return;
          });








  }

};