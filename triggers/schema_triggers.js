var chokidar = require('chokidar');
var path = require('path');
var settings = require('settings');


chokidar.watch(path.join(settings.HDB_ROOT, "hdb/schema/system"), {ignored: /(^|[\/\\])\../,
}).on('all', function (event, path) {
    console.log(event, path);

});