"use strict";

const validator = require('./validationWrapper.js');

const constraints = {
    name : {
        presence : true
    },
    port : {
        presence : true
    },
    host: {
        presence : true
    }
};

module.exports = function(node) {
    return validator.validateObject(node, constraints);
};

