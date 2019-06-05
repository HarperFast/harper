const validator = require('./validationWrapper.js');

const constraints = {
    username: {
        presence: true,
        format: "[\\w\\-\\_]+",
        exclusion: {
            within: ["system"],
            message: "You cannot create tables within the system schema"
        }
    },
    password: {
        presence: true
    },
    role: {
        presence: true,
        format: "[\\w\\-\\_]+"
    },
    active: {
        presence: true,
        inclusion:{
            within: [true, false],
            message: "must be a boolean"
        }
    }
};

function addUserValidation(object) {
    constraints.password.presence = true;
    constraints.username.presence = true;
    constraints.role.presence = true;
    constraints.active.presence = true;
    return validator.validateObject(object, constraints);
}

function alterUserValidation(object) {
    constraints.password.presence = false;
    constraints.username.presence = true;
    constraints.role.presence = false;
    constraints.active.presence = false;
    return validator.validateObject(object, constraints);
}

function dropUserValidation(object) {
    constraints.password.presence = false;
    constraints.username.presence = true;
    constraints.role.presence = false;
    constraints.active.presence = false;
    return validator.validateObject(object, constraints);
}

module.exports = {
    addUserValidation: addUserValidation,
    alterUserValidation: alterUserValidation,
    dropUserValidation: dropUserValidation
};