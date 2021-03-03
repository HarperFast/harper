const _ = require('lodash'),
    validator = require('./validationWrapper');
const Joi = require('joi');
const hdb_terms = require('../utility/common_utils');
const { common_validators, schema_regex } = require('./common_validators');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES, VALIDATION_ERROR_MSGS } = hdb_errors;

const schema_joi = Joi.alternatives(
        Joi.string().min(1).max(common_validators.schema_length.maximum).pattern(schema_regex)
            .messages({'string.pattern.base': '{:#label} ' + common_validators.schema_format.message}),
        Joi.number()).required();

const search_by_hashes_schema = Joi.object({
    schema: schema_joi,
    table: schema_joi,
    hash_values: Joi.array().min(1).items(Joi.alternatives(Joi.string(), Joi.number())).required(),
    get_attributes:Joi.array().min(1).items(schema_joi).required()
});

const search_by_value_schema = Joi.object({
    schema: schema_joi,
    table: schema_joi,
    search_attribute: schema_joi,
    search_value: Joi.any().required(),
    get_attributes: Joi.array().min(1).items(schema_joi).required(),
    desc: Joi.bool(),
    limit: Joi.number().integer().min(1),
    offset: Joi.number().integer().min(0),
});

const search_by_conditions_schema = Joi.object({
    schema: schema_joi,
    table: schema_joi,
    operator: Joi.string().allow('and', 'or').default('and'),
    offset: Joi.number().integer().min(0),
    limit: Joi.number().integer().min(1),
    get_attributes: Joi.array().min(1).items(schema_joi).required(),
    sort_attributes: Joi.array().min(1).items(Joi.object({
        attribute: schema_joi,
        desc: Joi.boolean()
    })),
    conditions: Joi.array().min(1).items(Joi.object({
        search_attribute: schema_joi,
        search_type: Joi.string().valid("equals", "contains", "starts_with", "ends_with", "greater_than", "greater_than_equal", "less_than", "less_than_equal", "between").required(),
        search_value: Joi.when('search_type', {
            switch: [
                { is: 'equals', then: Joi.any() },
                { is: 'between', then: Joi.array().items(Joi.alternatives([Joi.string(), Joi.number()])).length(2) }
            ],
            otherwise: Joi.alternatives(Joi.string(), Joi.number())
        }).required()
    })).required()
});

module.exports = function (search_object, type) {
    let validation_error = null;
    switch (type) {
        case 'value':
            validation_error = validator.validateBySchema(search_object, search_by_value_schema);
            break;
        case 'hashes':
            validation_error = validator.validateBySchema(search_object, search_by_hashes_schema);
            break;
        case 'conditions':
            validation_error = validator.validateBySchema(search_object, search_by_conditions_schema);
            break;
        default:
            throw new Error(`Error validating search, unknown type: ${type}`);
    }

    // validate table and attribute if format validation is valid
    if (!validation_error) {
        if (search_object.schema !== 'system') { // skip validation for system schema
            let check_schema_table = hdb_terms.checkGlobalSchemaTable(search_object.schema, search_object.table);
            if (check_schema_table) {
                return handleHDBError(new Error(), check_schema_table, HTTP_STATUS_CODES.NOT_FOUND);
            }

            let table_schema = global.hdb_schema[search_object.schema][search_object.table];
            let all_table_attributes = table_schema.attributes;

            //this clones the get_attributes array
            let check_attributes = [...search_object.get_attributes];

            if(type === 'value'){
                check_attributes.push(search_object.search_attribute);
            }

            if(type === 'conditions'){
                //this is used to validate sort attributes are in the conditions array
                let condition_attributes = [];
                for(let x = 0, length = search_object.conditions.length; x < length; x++){
                    let condition = search_object.conditions[x];
                    condition_attributes.push(condition.search_attribute.toString());
                    check_attributes.push(condition.search_attribute);
                }

                if(Array.isArray(search_object.sort_attributes)) {
                    for (let x = 0, length = search_object.sort_attributes.length; x < length; x++) {
                        let sort = search_object.sort_attributes[x];

                        //compare the sort attribute to the condition attributes, if it is not a hash attribute / or in the conditions we throw an error.
                        let sort_attr_str = sort.attribute.toString();
                        if(sort_attr_str !== table_schema.hash_attribute.toString() && condition_attributes.indexOf(sort_attr_str) < 0){
                            return handleHDBError(new Error(), VALIDATION_ERROR_MSGS.SEARCH_CONDITIONS_INVALID_SORT_ATTRIBUTE(sort_attr_str), HTTP_STATUS_CODES.BAD_REQUEST);
                        }

                        check_attributes.push(sort.attribute);
                    }
                }
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
