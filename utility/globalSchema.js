const schema = require('../data_layer/schemaDescribe'),
    async = require('async'),
    winston = require('../utility/logging/winston_logger'),
    system_schema = require('../json/systemSchema.json');

module.exports = {
    setSchemaDataToGlobal: setSchemaDataToGlobal,
    getTableSchema: getTableSchema,
    schemaSignal: schemaSignal,
    setUsersToGlobal: setUsersToGlobal,
    getSystemSchema: getSystemSchema
};

function setSchemaDataToGlobal(callback) {
    schema.describeAll(null, (err, data) => {
        if (err) {
            callback(err);
            return;
        }

        if(!data.system){
            data['system'] = system_schema;
        }

        global.hdb_schema = data;
        callback(null, null);
    });
}

function returnSchema(schema_name, table_name) {
    if (schema_name === 'system') {
        return system_schema[table_name];
    } else {
        return global.hdb_schema[schema_name][table_name];
    }
}

function getTableSchema(schema_name, table_name, callback) {
    if (!global.hdb_schema || !global.hdb_schema[schema_name] || !global.hdb_schema[schema_name][table_name]) {
        setTableDataToGlobal(schema_name, table_name, (err) => {
            if (err) {
                return callback(err);
            }
            if (!global.hdb_schema[schema_name] || !global.hdb_schema[schema_name][table_name]) {
                return callback(`table ${schema_name}.${table_name} does not exist`);
            }
            callback(null, returnSchema(schema_name, table_name));
        });
    } else {
        callback(null, returnSchema(schema_name, table_name));
    }
}

function setTableDataToGlobal(schema_name, table, callback){
    let describe_object = {table:table,schema:schema_name};
    if(schema_name === 'system'){
        if(!global.hdb_schema){
            global.hdb_schema = {system: system_schema};
        } else {
            global.hdb_schema.system = system_schema;
        }

        callback();
        return;
    }

    schema.describeTable(describe_object, (err, table_info)=>{
        if(err){
            callback(err);
            return;
        }
        if(!table_info.schema && !table_info.table){
            callback();
            return;
        }

        if(!global.hdb_schema){
            global.hdb_schema = {system: system_schema};
        } else if(!global.hdb_schema[schema_name]) {
            global.hdb_schema[schema_name] = {};
        }

        global.hdb_schema[schema_name][table] = table_info;
        callback();
    });
}

function schemaSignal(callback){
    setSchemaDataToGlobal((err)=>{
        if(err){
           return winston.error(err);
        }
        callback();
    });
}

function setUsersToGlobal(callback){
    user.listUsers(null, (err, users)=>{
        if(err){
            return winston.error(err);
        }
        global.hdb_users = users;
        callback();
    });
}

function getSystemSchema(){
    return system_schema;
}

const user = require('../security/user')