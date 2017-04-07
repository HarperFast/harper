const delete_ = require('../data_layer/delete');

var delete_table_object = {"table":"person", "schema":"dev", "hash_attribute": "id", "hash_value": "7418"}
console.time('delete table test');

delete_.delete(delete_table_object, function(err, data){
    console.log(data);
    console.error(err);
    console.timeEnd('delete table test');

});

