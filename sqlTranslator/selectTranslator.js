const search = require('../data_layer/search2').search,
    SelectValidator = require('./SelectValidator').validator;


module.exports = {
    convertSelect:convertSelect
};

function convertSelect(statement, sql, callback) {
    try {
        let validator = new SelectValidator(statement);
        statement = validator.validate();
        search(statement, sql, (err, results)=>{
            if (err) {
                callback(err);
                return;
            }

            callback(null, results);
        });
    } catch(e) {
        callback(e);
    }
}