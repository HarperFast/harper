const { common_validators } = require('./common_validators');
const validator = require('./validationWrapper');

const is_required_string = 'is required';

const constraints = {
	database: {
		presence: false,
		format: common_validators.schema_format,
		length: common_validators.schema_length,
	},
	schema: {
		presence: false,
		format: common_validators.schema_format,
		length: common_validators.schema_length,
	},
	table: {
		presence: true,
		format: common_validators.schema_format,
		length: common_validators.schema_length,
	},
	attribute: {
		presence: true,
		format: common_validators.schema_format,
		length: common_validators.schema_length,
	},
	hash_attribute: {
		presence: true,
		format: common_validators.schema_format,
		length: common_validators.schema_length,
	},
};

function makeAttributesStrings(object) {
	for (let attr in object) {
		//setting the attribute to null allows the presence validators to work, also attempting to stringify a non-existent attribute throws an exception
		object[attr] =
			object[attr] === null || object[attr] === undefined || typeof object[attr] === 'object'
				? object[attr]
				: object[attr].toString();
	}
	return object;
}

function schema_object(object) {
	object = makeAttributesStrings(object);
	constraints.table.presence = false;
	constraints.attribute.presence = false;
	constraints.hash_attribute.presence = false;
	return validator.validateObject(object, constraints);
}

function table_object(object) {
	object = makeAttributesStrings(object);
	constraints.table.presence = { message: is_required_string };
	constraints.attribute.presence = false;
	constraints.hash_attribute.presence = false;
	return validator.validateObject(object, constraints);
}

function create_table_object(object) {
	object = makeAttributesStrings(object);
	constraints.table.presence = { message: is_required_string };
	constraints.attribute.presence = false;
	constraints.hash_attribute.presence = { message: is_required_string };
	return validator.validateObject(object, constraints);
}

function attribute_object(object) {
	object = makeAttributesStrings(object);
	constraints.table.presence = { message: is_required_string };
	constraints.attribute.presence = { message: is_required_string };
	constraints.hash_attribute.presence = false;
	return validator.validateObject(object, constraints);
}

function describe_table(object) {
	object = makeAttributesStrings(object);
	constraints.table.presence = { message: is_required_string };
	constraints.attribute.presence = false;
	constraints.hash_attribute.presence = false;
	return validator.validateObject(object, constraints);
}

/**
 * validates the residence attribute of the table object.  the residence must be an array of string if it is supplied
 * @param residence
 */
function validateTableResidence(residence) {
	if (!residence) {
		return;
	}

	if (!Array.isArray(residence)) {
		throw new Error('residence must be a string array');
	}

	if (residence.length === 0) {
		throw new Error('residence cannot be an empty array');
	}

	for (let x = 0; x < residence.length; x++) {
		if (typeof residence[x] !== 'string') {
			throw new Error(`residence must be a string array, item '${residence[x]}' is not a string`);
		}
	}
}

module.exports = {
	schema_object: schema_object,
	create_table_object: create_table_object,
	table_object: table_object,
	attribute_object: attribute_object,
	describe_table: describe_table,
	validateTableResidence: validateTableResidence,
};
