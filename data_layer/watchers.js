var chokidar = require('chokidar');
var path = require('path');
var settings = require('settings');

console.log(path.resolve(settings.HDB_ROOT + '/hdb/schema/system'));
console.log(__dirname);

chokidar.watch(path.resolve(settings.HDB_ROOT + '/hdb/schema/system'), {ignored: /(^|[\/\\])\../,
}).on('all', function (event, path) {
    console.log(event, path);

});