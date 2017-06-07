const fs = require('fs')
    , validate = require('validate.js'),
    PropertiesReader = require('properties-reader'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`),
    exec = require('child_process').exec
    delete_validator = require('../validation/deleteValidator'),
    schema = require('./schemaDescribe'),
    search = require('./search');
    hdb_properties.append(hdb_properties.get('settings_path'));


module.exports ={
  delete: function(delete_object, callback){
      validation = delete_validator(delete_object);
      if(validation){
          callback(validation);
          return;
      }

      var schemaDescribeObj  = {"table":delete_object.table, "schema":delete_object.schema};
      // TODO add * for get attributes in searchBy
      schema.describeTable(schemaDescribeObj, function(err, table_schema){
          if(err){
              callback(err);
              return;
          }


          let search_obj =
              {"schema": delete_object.schema,
                  "table": delete_object.table,
                  "hash_attribute":table_schema.hash_attribute,
                  "hash_value":delete_object.hash_value,
                  "get_attributes":[]};
          for(let attr in table_schema.attributes){
                  search_obj.get_attributes.push(table_schema.attributes[attr].attribute);

          }


          search.searchByHash(search_obj, function(err, data){
              if(err){
                  callback(err);
                  return;
              }

              if(!data || data.length < 1){
                  callback("Item not found!");
                  return;
              }

              var cmd = 'cd ' + hdb_properties.get('HDB_ROOT') +'/schema/' + delete_object.schema + '/' + delete_object.table+  ';';
              cmd += 'rm ./__hdb_hash/*/'+delete_object.hash_value+'.hdb;'
              cmd += 'rm ' + delete_object.hash_attribute + '/' + delete_object.hash_value + ' -r -f; ';

              for(attr in data[0]){
                  cmd += 'rm ' + attr + '/' + data[0][attr]  + '/' +delete_object.hash_value + ' -r -f; ';

              }
              exec(cmd, function (error, stdout, stderr) {
                  if(stderr){
                      console.log(stderr);
                      console.error(error);
                      callback('delete failed');
                      return;
                  }

                  callback(null, delete_object.hash_value + ' successfully deleted');
                  return;
              });
          });




      })








  }

};