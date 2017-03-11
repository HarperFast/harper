const validate = require('validate.js');


var search_by_hash_constraints = {
    schema: {
        presence: true,
        format: "[\\w\\-\\_]+",
        exclusion: {
            within: ["system"],
            message: "You cannot create tables within the system schema"
        }

    },
    table: {
        presence: true,
        format: "[\\w\\-\\_]+"

    },
    hash_attribute: {
        presence: true,
        format: "[\\w\\-\\_]+"

    },
    hash_value: {
        presence: true
    },
    get_attributes: {
        presence: true,
    }
};

module.exports = function(search_object) {

    // need to add validation to check if array for get attributes
    return validate(search_object, search_by_hash_constraints);
};