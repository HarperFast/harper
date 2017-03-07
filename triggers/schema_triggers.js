var chokidar = require('chokidar');
var path = require('path');
var settings = require('settings');
var createSchema = require('../data_layer/createSchema');
var dropSchema = require('../data_layer/dropSchema');
var createTable = require('../data_layer/createTable');
var dropTable = require('../data_layer/dropTable');
const insert = require('../data_layer/insert.js');


function makeSchema(path){
        var path_tokens = path.split('/');
        var params = path_tokens[path_tokens.length -1].split('.');
        var schema_create_object = {};
        schema_create_object.schema = params[0];
        return schema_create_object;
}


chokidar.watch(path.join(settings.HDB_ROOT, "hdb/schema/system/hdb_schema/name"), {ignored: /(^|[\/\\])\../,  ignoreInitial: true
}).on('all', function (event, path) {
       try {
               switch (event) {
                       case 'add':
                               var schemaObject = makeSchema(path);
                               createSchema.createSchemaStructure(schemaObject, function (err, result) {
                                       if (err)
                                               console.error(err);


                               });
                               break;
                       case 'unlink':
                               var schemaObject = makeSchema(path);
                               dropSchema.deleteSchemaStructure(schemaObject, function (err, result) {
                                       if (err)
                                               console.error(err);

                               });

                               break;

               }
       }catch(e){
               console.log(e);
       }



});

// fire on hdb_table modifications
chokidar.watch(path.join(settings.HDB_ROOT, "hdb/schema/system/hdb_table/schema_name"), {ignored: /(^|[\/\\])\../,  ignoreInitial: true
}).on('all', function (event, path) {


        try {
                function makeTableObject(path) {
                        var path_tokens = path.split('/');
                        var params = path_tokens[path_tokens.length - 1].split('.');
                        var table_object = {};
                        table_object.schema = params[0];
                        table_object.table = params[1];
                        table_object.hash_attribute = 'unknown';
                        return table_object;
                }


                switch (event) {
                        case 'add':
                                var tableObject = makeTableObject(path);
                                createTable.createTable(tableObject, function (err, result) {
                                        if (err)
                                                console.error(err);
                                        setTimeout(createTable.createTable(tableObject, function (err, result) {
                                                if (err)
                                                        console.error(err);


                                        }), 1000);

                                });
                                break;
                        case 'unlink':
                                var tableObject = makeTableObject(path);
                                dropTable.deleteTableStructure(tableObject, function (err, result) {
                                        if (err)
                                                console.error(err);

                                });

                                break;

                }

        }catch(e){
               console.error(e);
        }
    
});