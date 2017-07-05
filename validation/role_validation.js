var validate = require('validate.js');

var constraints = {
    role :{
        presence : true,
        format: "[\\w\\-\\_]+"

    },
    id :{
        presence : true,
        format: "[\\w\\-\\_]+"

    },
    permission: {
        presence: true
    }
};

function addRoleValidation(object){
    constraints.role.presence = true;
    constraints.id.presence = true;
    constraints.permission.presence = true;
    validate(object, constraints);
}

function alterRoleValidation(object){
    constraints.role.presence = false;
    constraints.id.presence = true;
    constraints.permission.presence = true;
    validate(object, constraints);
}


function dropRoleValidation(object){
    constraints.role.presence = false;
    constraints.id.presence = true;
    constraints.permission.presence = false;
    validate(object, constraints);
}



module.exports =  {
    addRoleValidation: addRoleValidation,
    alterRoleValidation: alterRoleValidation,
    dropRoleValidation: dropRoleValidation

};