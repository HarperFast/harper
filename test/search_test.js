const search = require('../data_layer/search');


var search_obj = {};
search_obj.schema = 'dev';
search_obj.table = 'person';
search_obj.hash_attribute = 'id';
search_obj.search_attribute = 'first_name';
search_obj.search_value = "K*'.'+([0-9])"
search_obj.hash_values = [];
search_obj.get_attributes = ['id', 'first_name'];

console.time('test');
search.searchByValue(search_obj, function (err, data) {
    if (err)
        console.error(err);
    console.log(data);
    console.timeEnd('test');
});



/**

var search_obj = {};
search_obj.schema = 'dev';
search_obj.table = 'person';
search_obj.hash_attribute = 'id';
search_obj.hash_value = '1';
search_obj.get_attributes = ['id', 'first_name', 'last_name' ];

console.time('test');
search.searchByHash(search_obj, function (err, data) {
    if (err)
        console.error(err);
    console.log(data);
    console.timeEnd('test');
});


/**

var search_obj = {};
search_obj.schema = 'system';
search_obj.table = 'hdb_table';
search_obj.hash_attribute = 'schema_name';
search_obj.search_attribute = 'name';
search_obj.search_value = '*'
search_obj.hash_values = [];
search_obj.get_attributes = ['name', 'schema_name', 'hash_attribute', 'schema'];
console.time('test');
search.searchByValue(search_obj, function (err, data) {
    if (err)
        console.error(err);
    console.log(data);
    console.timeEnd('test');
    return;
});
**/
