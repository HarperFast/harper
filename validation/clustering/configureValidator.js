const validator = require('../validationWrapper.js');
const terms = require('../../utility/hdbTerms');
const constraints = {
    CLUSTERING: {
        presence: false,
        inclusion: {
            within: [true, false, "true", "false"],
            message: "must be true or false."
        }
    },
    clustering_port: {
        presence: false,
        numericality: {
            onlyInteger: true,
            greaterThan: 1000,
            lessThanOrEqualTo: 65534,
            message: 'Must specify a valid port integer greater than 1000 and less than 65,354.'
        }
    },
    clustering_node_name: {
        presence: false,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "Node name must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    clustering_user_name: {
        presence: false,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "Node name must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    }
};

module.exports = function (delete_object) {
    return validator.validateObject(delete_object, constraints);
};