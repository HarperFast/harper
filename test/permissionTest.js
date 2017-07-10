const     global_schema = require('../utility/globalSchema')

function testPermissions(){
    let user = {

        "role":"a7cb91e9-32e4-4dbf-a327-fab4fa9191ea",
        "username": "sgoldberg"
    }
    let check_permission_object = {};
    check_permission_object.schema = 'dev';
    check_permission_object.table = 'person';
    check_permission_object.operation = 'insert';
    check_permission_object.user = user;
    check_permission_object.attributes = ['first_name'];

    const auth = require('../security/auth');

    global_schema.getTableSchema(check_permission_object.schema, check_permission_object.table, (err, table_schema) => {

    auth.checkPermissions(check_permission_object, function( err, data){
       winston.info(err);
       winston.info(data);

    })});



}

testPermissions()