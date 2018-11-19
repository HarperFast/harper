const insert = require('../../data_layer/insert');

module.exports = {
    worker: worker
};

function worker(schema, insert_data, callback){
    console.log(global);
    global.hdb_schema = schema;

    insert.insert(insert_data,callback);
}