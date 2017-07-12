const search = require('../data_layer/search');
/*var search_obj = {};
search_obj.schema = 'system';
search_obj.table = 'hdb_table';
search_obj.hash_attribute = 'id';
search_obj.search_attribute = 'schema';
search_obj.search_value = "dev"
search_obj.hash_values = [];
search_obj.get_attributes = ['hash_attribute', 'id', 'name', 'schema'];

console.time('searchByValue');
search.searchByValue(search_obj, function (err, data) {
    if (err){
        winston.error(err);
        return;
    }

    winston.info('PASS searchByValue');
    console.timeEnd('searchByValue');
    winston.info(data);
    return;
});*/

var search_obj = {};
search_obj.schema = 'dev';
search_obj.table = 'breed';
search_obj.hash_attribute = 'id';
search_obj.hash_values = ['2', '3', '4', '5', '6'];
search_obj.get_attributes = ['*'];

console.time('searchByHash');
search.searchByHash(search_obj, function (err, data) {
    if (err){
        winston.error(err);
        return;
    }

    winston.info('PASS searchByHash');
    console.timeEnd('searchByHash');
    winston.info(data);
    return;
});