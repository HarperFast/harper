const fs = require('fs')
    , validate = require('validate.js'),
    PropertiesReader = require('properties-reader'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`),
    exec = require('child_process').exec
    delete_validator = require('../validation/deleteValidator'),
    del = require('del'),
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
              const regex = /\//g;
              let hash_value_stripped = String(delete_object.hash_value).replace(regex, '').substring(0, 4000);

              var commandArray = [];
             // var cmd = 'cd ' + hdb_properties.get('HDB_ROOT') +'/schema/' + delete_object.schema + '/' + delete_object.table+  ';';
              commandArray.push(`${hdb_properties.get('HDB_ROOT')}/schema/${delete_object.schema}/${delete_object.table}/__hdb_hash/*/${delete_object.hash_value}.hdb`);
              commandArray.push(`${hdb_properties.get('HDB_ROOT')}/schema/${delete_object.schema}/${delete_object.table}/${delete_object.hash_attribute}/${hash_value_stripped}`);
              for(attr in data[0]){
                  let attr_value_stripped = String(data[0][attr]).replace(regex, '').substring(0, 4000);
                  commandArray.push(`${hdb_properties.get('HDB_ROOT')}/schema/${delete_object.schema}/${delete_object.table}/${attr}/${attr_value_stripped}/${delete_object.hash_value}.hdb`);

              }

              del(commandArray, {force: true}).then(paths => {
                  callback(null, delete_object.hash_value + ' successfully deleted');
                  return;
              }).catch((err)=>{
                  callback(err);
              });


          });




      })








  }

};