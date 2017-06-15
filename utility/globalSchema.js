const schema = require('../data_layer/schemaDescribe');

module.exports = {
    setSchemaDataToGlobal: setSchemaDataToGlobal
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
                    hdb_attribute:{
                        hash_attribute:'id',
                        name:'hdb_attribute',
                        schema:'system'
                    },
                    hdb_schema:{
                        hash_attribute:'name',
                        name:'hdb_schema',
                        schema:'system'
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