var chokidar = require('chokidar');
var path = require('path');
var settings = require('settings');
var schema = require('../data_layer/schema');
const insert = require('../data_layer/insert.js');


function makeSchema(path) {
    var path_tokens = path.split('/');
    var params = path_tokens[path_tokens.length - 1].split('.');
    var schema_create_object = {};
    schema_create_object.schema = params[0];
    return schema_create_object;
}


chokidar.watch(path.join(settings.HDB_ROOT, "hdb/schema/system/hdb_schema/name"), {
    ignored: /(^|[\/\\])\../, ignoreInitial: true
}).on('all', function (event, path) {
    try {
        switch (event) {
            case 'add':
                var schemaObject = makeSchema(path);
                schema.createSchemaStructure(schemaObject, function (err, result) {
                    if (err)
                        console.error(err);


                });
                break;
            case 'unlink':
                var schemaObject = makeSchema(path);
                schema.deleteSchemaStructure(schemaObject, function (err, result) {
                    if (err)
                        console.error(err);

                });

                break;

        }
    } catch (e) {
        console.log(e);
    }


});

// fire on hdb_table modifications
chokidar.watch(path.join(settings.HDB_ROOT, "hdb/schema/system/hdb_table/schema_name"), {
    ignored: /(^|[\/\\])\../, ignoreInitial: true
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
                schema.createTable(tableObject, function (err, result) {
                    if (err)
                        console.error(err);
                    setTimeout(schema.createTable(tableObject, function (err, result) {
                        if (err)
                            console.error(err);


                    }), 1000);

                });
                break;
            case 'unlink':
                var tableObject = makeTableObject(path);
                schema.deleteTableStructure(tableObject, function (err, result) {
                    if (err)
                        console.error(err);

                });

                break;

        }

    } catch (e) {
        console.error(e);
    }

});


// fire on hdb_table modifications
chokidar.watch(path.join(settings.HDB_ROOT, "hdb/schema/"), {
    ignored: /(^|[\/\\])\../, ignoreInitial: true
}).on('addDir', function (event, path) {

    var tokens = event.split('/');
    console.log(tokens.length - tokens.indexOf('schema'));
    if (tokens.length - tokens.indexOf('schema') > 3 && tokens[tokens.indexOf('schema') + 1] != 'system') {
        var schema = tokens[tokens.length - 3];
        var table = tokens[tokens.length - 2];
        var attribute = tokens[tokens.length - 1];
        var attribute_object = {};
        attribute_object.table = table;
        attribute_object.schema = schema;tokens
        attribute_object.name = attribute;
        attribute_object.hash = schema + '.' + table + '.' + attribute;


        var insertWrapper = {};tokens
        insertWrapper.hash_attribute = 'hash'
        insertWrapper.table = 'hdb_attribute';
        insertWrapper.schema = 'system';
        insertWrapper.records = [attribute_object];

        console.log(JSON.stringify(insertWrapper));

        insert.insert(insertWrapper, function (err, result) {
            if (err)
                console.error(err);
            console.log(result);

        });


    }
    console.log(event);
    console.log(path);


});