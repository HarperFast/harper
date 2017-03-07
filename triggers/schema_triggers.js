var chokidar = require('chokidar');
var path = require('path');
var settings = require('settings');
var schema = require('../data_layer/createSchema');


chokidar.watch(path.join(settings.HDB_ROOT, "hdb/schema/system/hdb_schema/name"), {ignored: /(^|[\/\\])\../,  ignoreInitial: true
}).on('all', function (event, path) {
        console.log('-------trigger-------')
        console.log('event:' + event + ' path:' + path)

});

// fire on hdb_table modifications
chokidar.watch(path.join(settings.HDB_ROOT, "hdb/schema/system/hdb_table/schema_name"), {ignored: /(^|[\/\\])\../,  ignoreInitial: true
}).on('all', function (event, path) {
        console.log('-------trigger-------')
        console.log('event:' + event + ' path:' + path)
    
});