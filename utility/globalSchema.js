const system_schema = require('../json/systemSchema.json');
const { callbackify, promisify } = require('util');
const dbs = require('../resources/databases');

module.exports = {
	setSchemaDataToGlobal: setSchemaDataToGlobal,
	getTableSchema: getTableSchema,
	getSystemSchema: getSystemSchema,
	setSchemaDataToGlobalAsync: promisify(setSchemaDataToGlobal),
};

// These require statements were moved below the module.exports to resolve circular dependencies within the harperBridge module.
const schema = require('../dataLayer/schemaDescribe');

// callbackified functions
let c_schema_describe_all = callbackify(schema.describeAll);
let c_schema_describe_table = callbackify(schema.describeTable);

function setSchemaDataToGlobal(callback) {
	global.hdb_schema = dbs.getDatabases();
	if (callback) callback();
}

function returnSchema(schema_name, table_name) {
	if (schema_name === 'system') {
		return system_schema[table_name];
	} else {
		return global.hdb_schema[schema_name][table_name];
	}
}

function getTableSchema(schema_name, table_name, callback) {
	let database = getDatabases()[schema_name];
	if (!database) {
		return callback(`schema ${schema_name} does not exist`);
	}
	let table = database[table_name];
	if (!table) {
		return callback(`table ${schema_name}.${table_name} does not exist`);
	}
	return callback(null, {
		schema: schema_name,
		name: table_name,
		hash_attribute: table.primaryKey,
	});
}

function setTableDataToGlobal(schema_name, table, callback) {
	let describe_object = { table: table, schema: schema_name };
	if (schema_name === 'system') {
		if (!global.hdb_schema) {
			global.hdb_schema = { system: system_schema };
		} else {
			global.hdb_schema.system = system_schema;
		}

		callback();
		return;
	}
	c_schema_describe_table(describe_object, (err, table_info) => {
		if (err) {
			callback(err);
			return;
		}
		if (!table_info.schema && !table_info.name) {
			callback();
			return;
		}

		if (!global.hdb_schema) {
			global.hdb_schema = { system: system_schema };
		}

		if (!global.hdb_schema[schema_name]) {
			global.hdb_schema[schema_name] = {};
		}

		global.hdb_schema[schema_name][table] = table_info;
		callback();
	});
}

function getSystemSchema() {
	return system_schema;
}
