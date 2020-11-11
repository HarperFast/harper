const _ = require('lodash'),
    validator = require('./validationWrapper');
const hdb_terms = require('../utility/common_utils');
const { common_validators, schema_regex } = require('./common_validators');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;

let search_by_hash_constraints = {
    schema: {
        presence: true,
        format: common_validators.schema_format,
        length: common_validators.schema_length
    },
    table: {
        presence: true,
        format: common_validators.schema_format,
        length: common_validators.schema_length
    },
    hash_attribute: {
        presence: true,
        format: schema_regex
    },
    hash_value: {
        presence: true
    },
    get_attributes: {
        presence: true
    }
};

let search_by_hashes_constraints = {
    schema: {
        presence: true,
        format: common_validators.schema_format,
        length: common_validators.schema_length
    },
    table: {
        presence: true,
        format: common_validators.schema_format,
        length: common_validators.schema_length
    },
    hash_values: {
        presence: true
    },
    get_attributes: {
        presence: true
    }
};

let search_by_value_constraints = {
    schema: {
        presence: true,
        format: common_validators.schema_format,
        length: common_validators.schema_length
    },
    table: {
        presence: true,
        format: common_validators.schema_format,
        length: common_validators.schema_length
    },
    search_attribute: {
        presence: true
    },
    get_attributes: {
        presence: true
    }
};

let search_by_conditions = {
    schema: {
        presence: true,
        format: common_validators.schema_format,
        length: common_validators.schema_length
    },
    table: {
        presence: true,
        format: common_validators.schema_format,
        length: common_validators.schema_length
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
        default:
            throw new Error(`Error validating search, unknown type: ${type}`);
    }

    // validate table and attribute if format validation is valid
    if (!validation_error) {
        if (!hdb_terms.isEmpty(search_object.hash_values) && !Array.isArray(search_object.hash_values)) {
            return new Error('hash_values must be an array');
        }

        if (!hdb_terms.isEmpty(search_object.get_attributes) && !Array.isArray(search_object.get_attributes)) {
            return new Error('get_attributes must be an array');
        }

        if (search_object.schema !== 'system') { // skip validation for system schema
            let check_schema_table = hdb_terms.checkGlobalSchemaTable(search_object.schema, search_object.table);
            if (check_schema_table) {
                return handleHDBError(new Error(), check_schema_table, HTTP_STATUS_CODES.NOT_FOUND);
            }

            let all_table_attributes = global.hdb_schema[search_object.schema][search_object.table].attributes;

            //this clones the get_attributes array
            let check_attributes = [...search_object.get_attributes];

            if(type === 'value'){
                check_attributes.push(search_object.search_attribute);
            }

            let unknown_attributes = _.filter(check_attributes, (attribute) => attribute !== '*' && attribute.attribute !== '*' && // skip check for asterik attribute
                    !_.some(all_table_attributes, (table_attribute) => // attribute should match one of the attribute in global
                         table_attribute === attribute || table_attribute.attribute === attribute || table_attribute.attribute === attribute.attribute
                    ));

            // if any unknown attributes present in the search request then list all indicated as unknown attribute to error message at once split in well format
            // for instance "unknown attribute a, b and c" or "unknown attribute a"
            if (unknown_attributes && unknown_attributes.length > 0) {
                // return error with proper message - replace last comma with and
                let error_msg = unknown_attributes.join(', ');
                error_msg = error_msg.replace(/,([^,]*)$/, ' and$1');
                return new Error(`unknown attribute '${error_msg}'`);
            }
        }
    }

    return validation_error;
};
