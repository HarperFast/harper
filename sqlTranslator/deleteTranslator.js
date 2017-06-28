const condition_parser = require('./conditionParser'),
    deleter = require('../data_layer/delete');

module.exports = {
    convertDelete:convertDelete
};

function convertDelete(statement, callback){
    try{
        let delete_wrapper = {};
        let schema_table = statement.from.name.split('.');

        delete_wrapper.schema = schema_table[0];
        delete_wrapper.table = schema_table[1];

        delete_wrapper.conditions = condition_parser.parseConditions(statement.where);

        deleter.conditionalDelete(delete_wrapper, (err, results)=>{
            if(err){
                callback(err);
                return;
            }

            callback(null, results);
        });

    } catch(e){
        callback(e);
    }
}