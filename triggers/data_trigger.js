const chokidar = require('chokidar'),
    path = require('path'),
    settings = require('settings'),
    hidefile = require('hidefile'),
    glob = require('glob');


chokidar.watch(path.join(settings.HDB_ROOT, "hdb/schema/system"), {ignored: /(^|[\/\\])\../,
}).on('all', function (event, path) {
    console.log(event, path);

});

function sortByDate(a,b) {
    a_date = Number(a.split('-')[1]);
    b_date = Number(b.split('-')[1]);
    return a_date > b_date ? -1 : a<b ? 1 : 0;
}

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
