const condition_parser = require('./conditionParser'),
    update = require('../data_layer/update');

module.exports = {
    convertUpdate:convertUpdate
};

function convertUpdate(statement, callback){
    try{
        let update_wrapper = {};
        let schema_table = statement.into.name.split('.');

        if(schema_table.length !== 2){
            callback(`invalid table ${statement.into.name}`);
            return;
        }

        update_wrapper.schema = schema_table[0];
        update_wrapper.table = schema_table[1];

        update_wrapper.record = createUpdateRecord(statement.set);

        update_wrapper.conditions = condition_parser.parseConditions(statement.where);

        update.update(update_wrapper, (err, results)=>{
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

function createUpdateRecord(set_list){
    let record = {};
    set_list.forEach((assignment)=>{
        record[assignment.target.name] = assignment.value.value;
    });

    return record;
}