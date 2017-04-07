const fs = require('fs')
    ,validate = require('validate.js')
    ,schema = require('./schema')
    ,settings = require('settings')
    ,spawn = require('child_process').spawn
    ,delete_validator = require('../validation/deleteValidator')
    ,search =require('search.js');


module.exports ={
  delete: function(delete_object){
      validation = delete_validator(delete_object);
      if(validation){
          callback(validation);
          return;
      }

      schema.describeTable({"table": delete_object.table, "schema": delete_object.schema},function(err, table_result){
          var cmd = 'ls -d ' + value_path + '/' + search_string;
          console.log(cmd)
          exec(cmd, function (error, stdout, stderr) {
            // do some stuff.
              console.log(stdout);
          });

      } );






  }

};