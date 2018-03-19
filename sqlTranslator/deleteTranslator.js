const condition_parser = require('./conditionParser'),
    deleter = require('../data_layer/delete'),
    alasql = require('alasql'),
    async = require('async'),
    search = require('../data_layer/search'),
    _delete = require('../data_layer/delete');

const SUCCESS_MESSAGE = 'records successfully deleted';

module.exports = {
    convertDelete:convertDelete
};

function convertDelete(statement, callback){
    try{
        //convert this update statement to a search capable statement
        //use javascript destructuring to assign variables into from & where
        let {table: from, where} = statement;
        let search_statement = new alasql.yy.Select();
        let columns = [new alasql.yy.Column({columnid:'*', tableid: statement.table.tableid})];
        search_statement.columns = columns;
        search_statement.from = [from];
        search_statement.where = where;

        async.waterfall([
            search.search.bind(null, search_statement),
            _delete.deleteRecords.bind(null, from.databaseid, from.tableid),
        ], (err)=>{
            if(err){
                if(err.hdb_code){
                    return callback(null, err.message);
                }
                return callback(err);
            }

            callback(null, SUCCESS_MESSAGE);
        });

    } catch(e){
        callback(e);
    }
}