const chokidar = require('chokidar'),
    path = require('path'),
    settings = require('settings'),
    hidefile = require('hidefile'),
    glob = require('glob'),
    watchr = require('watchr');
const hdb_path = path.join(settings.PROJECT_DIR, '/hdb/schema');

// Define our watching parameters

function listener (changeType, fullPath, currentStat, previousStat) {
    switch ( changeType ) {
        case 'update':
            console.log('the file', fullPath, 'was updated', currentStat, previousStat);
            break;
        case 'create':
            console.log('the file', fullPath, 'was created', currentStat, previousStat);
            break;
        case 'delete':
            console.log('the file', fullPath, 'was deleted', previousStat);
            break;
    }
}
function next (err) {
    if ( err )  return console.log('watch failed on', path, 'with error', err)
    {
        console.log('watch successful on', path);
    }
}

// Watch the path with the change listener and completion callback
var stalker = watchr.open(hdb_path, listener, next);

// Close the stalker of the watcher
//stalker.close();


/*chokidar.watch(path.join(hdb_path, "dev/person/id"), {ignoreInitial: false,
}).on('raw', (event, path, details) => { console.log('Raw event info:', event, path, details); });

function sortByDate(a,b) {
    a_date = Number(a.split('-')[1]);
    b_date = Number(b.split('-')[1]);
    return a_date > b_date ? -1 : a<b ? 1 : 0;
}*/

/*
if(!attribute.is_hash) {
    glob('*-' + attribute.hash_value + '.hdb', {cwd: attribute_path}, function (err, d) {
        if (err) {
            console.error(err);
        } else {
            if(d.length > 0) {
                console.log(d.sort(sortByDate));
                //  d.forEach(function)
            }
        }
    });
}*/
