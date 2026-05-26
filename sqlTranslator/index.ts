'use strict';

import * as insert from '../dataLayer/insert.ts';
import * as util from 'util';
const cbInsertInsert = util.callbackify(insert.insert);
import { search } from '../dataLayer/search.ts';
import { update } from '../dataLayer/update.ts';
const cbUpdateUpdate = util.callbackify(update);
import { convertDelete as deleteTranslator } from './deleteTranslator.ts';
const cbDeleteTranslator = util.callbackify(deleteTranslator);
import * as alasql from 'alasql';
import * as opAuth from '../utility/operation_authorization.ts';
import logger from '../utility/logging/harper_logger.ts';
import alasqlFunctionImporter from './alasqlFunctionImporter.ts';
import * as hdbUtils from '../utility/common_utils.ts';
import * as terms from '../utility/hdbTerms.ts';
import { handleHDBError } from '../utility/errors/hdbError.ts';
import { HTTP_STATUS_CODES } from '../utility/errors/commonErrors.ts';

//here we call to define and import custom functions to alasql
alasqlFunctionImporter(alasql);

let UNAUTHORIZED_RESPONSE = 403;
const SQL_INSERT_ERROR_MSG = 'There was a problem performing this insert. Please check the logs and try again.';

class ParsedSQLObject {
	ast: any;
	variant: any;
	permissions_checked: boolean;
	constructor() {
		this.ast = undefined;
		this.variant = undefined;
		this.permissions_checked = false;
	}
}

export function evaluateSQL(jsonMessage: any, callback: any) {
	let parsedSql = jsonMessage.parsed_sql_object;
	if (!parsedSql) {
		parsedSql = convertSQLToAST(jsonMessage.sql);
		//TODO; This is a temporary check and should be removed once validation is integrated.
		let schema = undefined;
		let statement = parsedSql.ast.statements[0];
		if (statement instanceof (alasql as any).yy.Insert) {
			schema = statement.into.databaseid;
		} else if (statement instanceof (alasql as any).yy.Select) {
			schema = statement.from ? statement.from[0].databaseid : null;
		} else if (statement instanceof (alasql as any).yy.Update) {
			schema = statement.table.databaseid;
		} else if (statement instanceof (alasql as any).yy.Delete) {
			schema = statement.table.databaseid;
		} else {
			logger.error(`AST in evaluateSQL is not a valid SQL type.`);
		}
		if (!(statement instanceof (alasql as any).yy.Select) && hdbUtils.isEmptyOrZeroLength(schema)) {
			return callback('No schema specified', null);
		}
	}
	processAST(jsonMessage, parsedSql, (error, results) => {
		if (error) {
			return callback(error);
		}

		callback(null, results);
	});
}

/**
 * Provides a direct path to checking permissions for a given AST.  Returns false if permissions check fails.
 * @param jsonMessage - The JSON inbound message.
 * @param parsedSqlObject - The Parsed SQL statement specified in the inbound json message, of type ParsedSQLObject.
 * @returns {Array} - False if permissions check denys the statement.
 */
export function checkASTPermissions(jsonMessage: any, parsedSqlObject: any) {
	let verifyResult = undefined;
	try {
		verifyResult = opAuth.verifyPermsAST(
			parsedSqlObject.ast.statements[0],
			jsonMessage.hdb_user,
			parsedSqlObject.variant
		);
		parsedSqlObject.permissions_checked = true;
	} catch (e) {
		throw e;
	}
	if (verifyResult) {
		return verifyResult;
	}
	return null;
}

export function convertSQLToAST(sql: string) {
	let astResponse = new ParsedSQLObject();
	if (!sql) {
		throw handleHDBError(
			new Error(),
			"The 'sql' parameter is missing from the request body",
			HTTP_STATUS_CODES.BAD_REQUEST
		);
	}
	try {
		let trimmedSql = sql.trim();
		let ast = alasql.parse(trimmedSql);
		let variant = trimmedSql.split(' ')[0].toLowerCase();
		astResponse.ast = ast;
		astResponse.variant = variant;
	} catch (e) {
		let splitError = e.message.split('\n');
		if (splitError[1]) {
			throw handleHDBError(
				e,
				`Invalid SQL at: ${splitError[1]}. Please ensure your SQL is valid. Try adding backticks to reserved words and schema table references.`,
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

	return astResponse;
}

export function processAST(jsonMessage: any, parsedSqlObject: any, callback: any) {
	try {
		let sqlFunction = nullFunction;

		if (!jsonMessage.bypass_auth && !parsedSqlObject.permissions_checked) {
			let permissionsCheck = checkASTPermissions(jsonMessage, parsedSqlObject);
			if (permissionsCheck && permissionsCheck.length > 0) {
				return callback(UNAUTHORIZED_RESPONSE, permissionsCheck);
			}
		}

		let statement = {
			statement: parsedSqlObject.ast.statements[0],
			hdb_user: jsonMessage.hdb_user,
		};

		switch (parsedSqlObject.variant) {
			case terms.VALID_SQL_OPS_ENUM.SELECT:
				sqlFunction = search;
				statement = parsedSqlObject.ast.statements[0];
				break;
			case terms.VALID_SQL_OPS_ENUM.INSERT:
				//TODO add validator for insert, need to make sure columns are specified
				sqlFunction = convertInsert;
				break;
			case terms.VALID_SQL_OPS_ENUM.UPDATE:
				sqlFunction = cbUpdateUpdate;
				break;
			case terms.VALID_SQL_OPS_ENUM.DELETE:
				sqlFunction = cbDeleteTranslator;
				break;
			default:
				throw new Error(`unsupported SQL type ${parsedSqlObject.variant} in SQL: ${jsonMessage}`);
		}
		sqlFunction(statement, (err, data) => {
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
	let schemaTable = statement.into;
	let insertObject: any = {
		schema: schemaTable.databaseid,
		table: schemaTable.tableid,
		operation: 'insert',
		hdb_user,
	};

	let columns = statement.columns.map((column) => column.columnid);

	try {
		insertObject.records = createDataObjects(columns, statement.values);
	} catch (e) {
		return callback(e);
	}

	cbInsertInsert(insertObject, (err, res) => {
		if (err) {
			return callback(err);
		}

		try {
			// We do not want the API returning the new attributes property.
			delete res.new_attributes;
			delete res.txn_time;
		} catch (deleteErr) {
			logger.error(`Error delete new_attributes from insert response: ${deleteErr}`);
		}

		callback(null, res);
	});
}

function createDataObjects(columns, values) {
	try {
		return values.map((valueObjects) => {
			//compare number of values to number of columns, if no match throw error
			if (columns.length !== valueObjects.length) {
				throw 'number of values do not match number of columns in insert';
			}
			let record = {};
			//make sure none of the value entries have a columnid
			valueObjects.forEach((value, x) => {
				if (value.columnid) {
					throw 'cannot use a column in insert value';
				}

				if ('value' in value) {
					record[columns[x]] = value.value;
				} else {
					record[columns[x]] = (alasql as any).compile(`SELECT ${value.toString()} AS [${terms.FUNC_VAL}] FROM ?`);
				}
			});

			return record;
		});
	} catch (err) {
		logger.error(err);
		throw new Error(SQL_INSERT_ERROR_MSG);
	}
}
