const schema = require('../data_layer/schema');

module.exports = {
    setSchemaDataToGlobal: setSchemaDataToGlobal
};

function setSchemaDataToGlobal(callback){
    if(!global.hdb_schema){
        schema.describeSchema({schema:'dev'}, (err, data)=> {
            if (err) {
                callback(err);
                return;
            }
            global.hdb_schema = data;
            callback(null, null);
        });
    } else {
        callback(null, null);
    }


}