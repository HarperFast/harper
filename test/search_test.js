const search = require('../data_layer/search');
var search_obj = {};
search_obj.schema = 'dev';
search_obj.table = 'person';
search_obj.hash_attribute = 'id';
search_obj.search_attribute = 'first_name';
search_obj.search_value = "Ky"
search_obj.hash_values = [];
search_obj.get_attributes = ['id', 'first_name'];

console.time('searchByValue');
search.searchByValue(search_obj, function (err, data) {
    if (err){
        console.error(err);
        return;
    }

    console.log('PASS searchByValue');
    console.timeEnd('searchByValue');
    console.log(data);
    return;
});
/*
var search_obj = {};
search_obj.schema = 'dev';
search_obj.table = 'person';
search_obj.hash_attribute = 'id';
search_obj.hash_values = ['1', '465', '343', '436', '765'];
search_obj.get_attributes = ['id', 'first_name', 'last_name' ];

console.time('searchByHash');
search.searchByHashes(search_obj, function (err, data) {
    if (err){
        console.error(err);
        return;
    }

    console.log('PASS searchByHash');
    console.timeEnd('searchByHash');
    console.log(data);
    return;
});*/



