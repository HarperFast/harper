'use strict';

module.exports = {
	evaluateSQL,
	processAST,
	convertSQLToAST,
	checkASTPermissions,
};

const insert = require('../data_layer/insert');
const util = require('util');
const cb_insert_insert = util.callbackify(insert.insert);
const search = require('../data_layer/search').search;
const update = require('../data_layer/update').update;
const cb_update_update = util.callbackify(update);
const delete_translator = require('./deleteTranslator').convertDelete;
const alasql = require('alasql');
const op_auth = require('../utility/operation_authorization');
const logger = require('../utility/logging/harper_logger');
const alasql_function_importer = require('./alasqlFunctionImporter');
const hdb_utils = require('../utility/common_utils');
const terms = require('../utility/hdbTerms');
const { hdb_errors, handleHDBError } = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;
const transact_to_clustering_utilities = require('../utility/clustering/transactToClusteringUtilities');
const cb_post_operation_handler = util.callbackify(transact_to_clustering_utilities.postOperationHandler);

//here we call to define and import custom functions to alasql
alasql_function_importer(alasql);

let UNAUTHORIZED_RESPONSE = 403;
const SQL_INSERT_ERROR_MSG = 'There was a problem performing this insert. Please check the logs and try again.';

class ParsedSQLObject {
	constructor() {
		this.ast = undefined;
		this.variant = undefined;
		this.permissions_checked = false;
	}
}

function evaluateSQL(json_message, callback) {
	let parsed_sql = json_message.parsed_sql_object;
	if (!parsed_sql) {
		parsed_sql = convertSQLToAST(json_message.sql);
		//TODO; This is a temporary check and should be removed once validation is integrated.
		let schema = undefined;
		let statement = parsed_sql.ast.statements[0];
		if (statement instanceof alasql.yy.Insert) {
			schema = statement.into.databaseid;
		} else if (statement instanceof alasql.yy.Select) {
			schema = statement.from ? statement.from[0].databaseid : null;
		} else if (statement instanceof alasql.yy.Update) {
			schema = statement.table.databaseid;
		} else if (statement instanceof alasql.yy.Delete) {
			schema = statement.table.databaseid;
		} else {
			logger.error(`AST in evaluateSQL is not a valid SQL type.`);
		}
		if (!(statement instanceof alasql.yy.Select) && hdb_utils.isEmptyOrZeroLength(schema)) {
			return callback('No schema specified', null);
		}
	}
	processAST(json_message, parsed_sql, (error, results) => {
		if (error) {
			return callback(error);
		}

		callback(null, results);
	});
}

/**
 * Provides a direct path to checking permissions for a given AST.  Returns false if permissions check fails.
 * @param json_message - The JSON inbound message.
 * @param parsed_sql_object - The Parsed SQL statement specified in the inbound json message, of type ParsedSQLObject.
 * @returns {Array} - False if permissions check denys the statement.
 */
function checkASTPermissions(json_message, parsed_sql_object) {
	let verify_result = undefined;
	try {
		verify_result = op_auth.verifyPermsAst(
			parsed_sql_object.ast.statements[0],
			json_message.hdb_user,
			parsed_sql_object.variant
		);
		parsed_sql_object.permissions_checked = true;
	} catch (e) {
		throw e;
	}
	if (verify_result) {
		return verify_result;
	}
	return null;
}

function convertSQLToAST(sql) {
	let ast_response = new ParsedSQLObject();
	if (!sql) {
		throw handleHDBError(
			new Error(),
			"The 'sql' parameter is missing from the request body",
			HTTP_STATUS_CODES.BAD_REQUEST
		);
	}
	try {
		let trimmed_sql = sql.trim();
		let ast = alasql.parse(trimmed_sql);
		let variant = trimmed_sql.split(' ')[0].toLowerCase();
		ast_response.ast = ast;
		ast_response.variant = variant;
	} catch (e) {
		let split_error = e.message.split('\n');
		if (split_error[1]) {
			throw handleHDBError(
				e,
				`Invalid SQL at: ${split_error[1]}. Please ensure your SQL is valid. Try adding backticks to reserved words and schema table references.`,
				HTTP_STATUS_CODES.BAD_REQUEST
			);
		} else {
			throw handleHDBError(
				e,
				`We had trouble parsing your request. Please ensure your SQL is valid. Try adding backticks to reserved words and schema table references.`,
				HTTP_STATUS_CODES.BAD_REQUEST
			);
		}
	}

	return ast_response;
}

function processAST(json_message, parsed_sql_object, callback) {
	try {
		let sql_function = nullFunction;

		if (!json_message.bypass_auth && !parsed_sql_object.permissions_checked) {
			let permissions_check = checkASTPermissions(json_message, parsed_sql_object);
			if (permissions_check && permissions_check.length > 0) {
				return callback(UNAUTHORIZED_RESPONSE, permissions_check);
			}
		}

		let statement = {
			statement: parsed_sql_object.ast.statements[0],
			hdb_user: json_message.hdb_user,
		};

		switch (parsed_sql_object.variant) {
			case terms.VALID_SQL_OPS_ENUM.SELECT:
				sql_function = search;
				statement = parsed_sql_object.ast.statements[0];
				break;
			case terms.VALID_SQL_OPS_ENUM.INSERT:
				//TODO add validator for insert, need to make sure columns are specified
				sql_function = convertInsert;
				break;
			case terms.VALID_SQL_OPS_ENUM.UPDATE:
				sql_function = cb_update_update;
				break;
			case terms.VALID_SQL_OPS_ENUM.DELETE:
				sql_function = delete_translator;
				break;
			default:
				throw new Error(`unsupported SQL type ${parsed_sql_object.variant} in SQL: ${json_message}`);
		}

		sql_function(statement, (err, data) => {
			if (err) {
				callback(err);
				return;
			}
			callback(null, data);
		});
	} catch (e) {
		return callback(e);
	}
}

function nullFunction(sql, callback) {
	logger.info(sql);
	callback('unknown sql statement');
}

function convertInsert({ statement, hdb_user }, callback) {
	let schema_table = statement.into;
	let insert_object = {
		schema: schema_table.databaseid,
		table: schema_table.tableid,
		operation: 'insert',
		hdb_user: hdb_user,
	};

	let columns = statement.columns.map((column) => column.columnid);

	try {
		insert_object.records = createDataObjects(columns, statement.values);
	} catch (e) {
		return callback(e);
	}

	cb_insert_insert(insert_object, (err, res) => {
		if (err) {
			return callback(err);
		}

		// With non SQL CUD actions, the `post` operation passed into OperationFunctionCaller would send the transaction to the cluster.
		// Since we don`t send Most SQL options to the cluster, we need to explicitly send it.
		cb_post_operation_handler(insert_object, res, (post_op_err) => {
			if (post_op_err) {
				logger.error(post_op_err);
			}
		});

		try {
			// We do not want the API returning the new attributes property.
			delete res.new_attributes;
			delete res.txn_time;
		} catch (delete_err) {
			logger.error(`Error delete new_attributes from insert response: ${delete_err}`);
		}

		callback(null, res);
	});
}

function createDataObjects(columns, values) {
	try {
		return values.map((value_objects) => {
			//compare number of values to number of columns, if no match throw error
			if (columns.length !== value_objects.length) {
				throw 'number of values do not match number of columns in insert';
			}
			let record = {};
			//make sure none of the value entries have a columnid
			value_objects.forEach((value, x) => {
				if (value.columnid) {
					throw 'cannot use a column in insert value';
				}

				if ('value' in value) {
					record[columns[x]] = value.value;
				} else {
					record[columns[x]] = alasql.compile(`SELECT ${value.toString()} AS [${terms.FUNC_VAL}] FROM ?`);
				}
			});

			return record;
		});
	} catch (err) {
		logger.error(err);
		throw new Error(SQL_INSERT_ERROR_MSG);
	}
}
