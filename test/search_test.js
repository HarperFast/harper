const search = require('../data_layer/search');
/**

var search_obj = {};
search_obj.schema = 'dev';
search_obj.table = 'person';
search_obj.hash_attribute = 'id';
search_obj.search_attribute = 'last_name';
search_obj.search_value = 'Ben*'
search_obj.hash_values = [];
search_obj.get_attributes = ['id', 'first_name', 'last_name'];

console.time('test');
search.searchByValue(search_obj, function (err, data) {
    if (err)
        console.error(err);
    console.log(data);
    console.timeEnd('test');
});
**/

/**

var search_obj = {};
search_obj.schema = 'dev';
search_obj.table = 'dog';
search_obj.hash_attribute = 'id';
search_obj.hash_value = '1';
search_obj.get_attributes = ['id', 'dog', 'breed', 'age', 'weight'];

console.time('test');
search.searchByHash(search_obj, function (err, data) {
    if (err)
        console.error(err);
    console.log(data);
    console.timeEnd('test');
});
**/



var search_obj = {};
search_obj.schema = 'system';
search_obj.table = 'hdb_table';
search_obj.hash_attribute = 'schema_name';
search_obj.search_attribute = 'name';
search_obj.search_value = '*'
search_obj.hash_values = [];
search_obj.get_attributes = ['name', 'bob', 'schema_name', 'hash_attribute', 'schema'];
console.time('test');
search.searchByValue(search_obj, function (err, data) {
    if (err)
        console.error(err);
    console.log(data);
    console.timeEnd('test');
    return;
});

/**

var insert = require('../data_layer/insert');

var records =[];

var harper = {};
harper.id = '1';

harper.name = 'harper';


var simon = {};
simon.id = 'simon-1';
simon.name = 'simon';

records = [harper, simon];



var insert_object = {
    schema :  'dev',
    table:'dog',
    hash_attribute: 'id',
    records: records
};

console.time('insertTest');
insert.insert(insert_object, function(err, data){
    if(err) {
        console.error(err);
    } else {
        console.log(data);
    }
    console.timeEnd('insertTest');
    //process.exit(0);
});**/