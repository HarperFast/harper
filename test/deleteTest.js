const delete_ = require('../data_layer/delete'),
    winston = require('../utility/logging/winston_logger');

let delete_table_object = {
    table:"genome",
    schema:"dev",
    hash_values: [4508]
};

console.time('delete table test');

delete_.delete(delete_table_object, function(err, data){
    winston.info(data);
    winston.error(err);
    console.timeEnd('delete table test');
});

