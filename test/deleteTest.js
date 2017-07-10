const delete_ = require('../data_layer/delete');

let delete_table_object = {
    table:"dog",
    schema:"dev",
    hash_values: [1]
};

console.time('delete table test');

delete_.delete(delete_table_object, function(err, data){
    winston.info(data);
    winston.error(err);
    console.timeEnd('delete table test');
});

