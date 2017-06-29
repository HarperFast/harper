const schema = require('../data_layer/schemaDescribe'),
    async = require('async');

module.exports = {
    setSchemaDataToGlobal: setSchemaDataToGlobal,
    getTableSchema: getTableSchema
};

function setSchemaDataToGlobal(callback){

    if(!global.hdb_schema){
        schema.describeAll((err, data)=> {
            if (err) {
                callback(err);
                return;
            }

            if(!data.system){
                data['system'] = {
                    hdb_table:{
                        hash_attribute:'id',
                        name:'hdb_table',
                        schema:'system',
                        attributes:
                            [ { attribute: 'id' },
                                { attribute: 'name' },
                                { attribute: 'hash_attribute' },
                                { attribute: 'schema' }
                            ]

                },
                    hdb_drop_schema:{
                        hash_attribute:'id',
                        name:'hdb_drop_schema',
                        schema:'system'
                    },
                    hdb_attribute:{
                        hash_attribute:'id',
                        name:'hdb_attribute',
                        schema:'system'
                    },
                    hdb_schema:{
                        hash_attribute:'name',
                        name:'hdb_schema',
                        schema:'system',
                        attributes:
                            [
                                { attribute: 'name' },
                                { attribute: 'createddate' }
                            ]
                    },
                    hdb_user:{
                        hash_attribute:'id',
                        name:'hdb_user',
                        schema:'system'
                    },
                    hdb_license:{
                        hash_attribute:'license_key',
                        name:'hdb_license',
                        schema:'system'
                    }
                };
            }

            global.hdb_schema = data;
            callback(null, null);
        });
    } else {
        callback(null, null);
    }
}

function getTableSchema(schema_name, table_name, callback){
    async.during(
        (caller)=>{
            return caller(null, !global.hdb_schema);
        },
        setSchemaDataToGlobal,
        (err)=>{
            if(!global.hdb_schema || global.hdb_schema[schema_name] || !global.hdb_schema[schema_name][table_name]){
                setSchemaDataToGlobal((err, schema_data)=> {
                    if (err) {
                        callback(err);
                        return;
                    }

                    if(!global.hdb_schema[schema_name] || !global.hdb_schema[schema_name][table_name]){
                        callback(`table ${schema_name}.${table_name} does not exist`);
                    } else {
                        callback(null, global.hdb_schema[schema_name][table_name]);
                    }
                });
            } else {
                callback(null, global.hdb_schema[schema_name][table_name]);
            }
        }
    );


}

