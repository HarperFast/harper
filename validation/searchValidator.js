const validate = require('validate.js'),
    _ = require('lodash'),
    validator = require('./validationWrapper.js');

let search_by_hash_constraints = {
    schema: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    table: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
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

let search_by_hashes_constraints = {
    schema: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    table: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    hash_values: {
        presence: true
    },
    get_attributes: {
        presence: true,
    }
};

let search_by_value_constraints = {
    schema: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    table: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    search_attribute: {
        presence: true
    },
    search_value: {
        presence: true
    },
    get_attributes: {
        presence: true
    }
};

let search_by_conditions = {
    schema: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    table: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "schema must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    conditions: {
        presence: true
    }
};

module.exports = function (search_object, type) {
    let validation_error = null;
    switch (type) {
        case 'hash':
            validation_error = validator.validateObject(search_object, search_by_hash_constraints);
            break;
        case 'value':
            validation_error = validator.validateObject(search_object, search_by_value_constraints);
            break;
        case 'hashes':
            validation_error = validator.validateObject(search_object, search_by_hashes_constraints);
            break;
        case 'conditions':
            validation_error = validator.validateObject(search_object, search_by_conditions);
            break;
    }

    if (!validation_error) {
        if (search_object.schema !== 'system') {
            if (!global.hdb_schema[search_object.schema] || !global.hdb_schema[search_object.schema][search_object.table]) {
                return new Error(`invalid table ${search_object.schema}.${search_object.table}`);
            }
            let all_table_attributes = global.hdb_schema[search_object.schema][search_object.table].attributes;
            let unknown_attributes =  _.filter(search_object.get_attributes, (attribute)=> {
                return !_.some(all_table_attributes, (table_attribute)=> {
                    return table_attribute === attribute || table_attribute.attribute === attribute;
                });
            });
            if (unknown_attributes && unknown_attributes.length > 0) {     
                return new Error(`unknown attribute ${unknown_attributes.join(', ')}`);
            }
        }
    }
    return validation_error;
    // TODO: need to add validation to check if array for get attributes
};