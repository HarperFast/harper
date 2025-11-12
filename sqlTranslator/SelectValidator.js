'use strict';

const RecursiveIterator = require('recursive-iterator');
const alasql = require('alasql');
const clone = require('clone');
const commonUtils = require('../utility/common_utils.js');
const { handleHDBError, hdbErrors } = require('../utility/errors/hdbError.js');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;
const { getDatabases } = require('../resources/databases.ts');

//exclusion list for validation on group bys
const customAggregators = ['DISTINCT_ARRAY'];

const validateTables = Symbol('validateTables'),
	validateTable = Symbol('validateTable'),
	getAllColumns = Symbol('getAllColumns'),
	validateAllColumns = Symbol('validateAllColumns'),
	findColumn = Symbol('findColumn'),
	validateOrderBy = Symbol('validateOrderBy'),
	validateSegment = Symbol('validateSegment'),
	validateColumn = Symbol('validateColumn'),
	setColumnsForTable = Symbol('setColumnsForTable'),
	checkColumnsForAsterisk = Symbol('checkColumnsForAsterisk'),
	validateGroupBy = Symbol('validateGroupBy'),
	hasColumns = Symbol('hasColumns');

const BETWEEN = 'BETWEEN';

/**
 * Validates the tables and attributes against the actual schema
 * Validates general SQL rules
 */
class SelectValidator {
	constructor(statement) {
		this.statement = statement;
		this.attributes = [];
	}

	/**
	 * entry point for validation
	 * @returns {*}
	 */
	validate() {
		if (!this.statement) {
			throw new Error('invalid sql statement');
		}

		this[validateTables]();
		this[checkColumnsForAsterisk]();
		this[validateAllColumns]();
	}

	/**
	 * if the statement has columns in it:
	 * loops thru the from and join arrays of the AST and passes individual entries into validateTable
	 */
	[validateTables]() {
		if (this[hasColumns]()) {
			if (!this.statement.from || this.statement.from.length === 0) {
				throw `no from clause`;
			}

			this.statement.from.forEach((table) => {
				this[validateTable](table);
			});

			if (this.statement.joins) {
				this.statement.joins.forEach((join) => {
					join.table.as = join.as;
					this[validateTable](join.table);
				});
			}
		}
	}

	/**
	 * check to see if there are columns in any part of the select
	 * @returns {boolean}
	 */
	[hasColumns]() {
		let hasColumns = false;
		let iterator = new RecursiveIterator(this.statement);
		for (let { node, path } of iterator) {
			if (node && node.columnid) {
				hasColumns = true;
				break;
			}
		}
		return hasColumns;
	}

	/**
	 * Checks that the table exists in the schema, adds all of it's attributes to the class level collection this.attributes
	 * @param table
	 */
	[validateTable](table) {
		if (!table.databaseid) {
			throw `schema not defined for table ${table.tableid}`;
		}
		let databases = getDatabases();
		if (!databases[table.databaseid]) {
			throw handleHDBError(new Error(), HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(table.databaseid), HTTP_STATUS_CODES.NOT_FOUND);
		}

		if (!databases[table.databaseid][table.tableid]) {
			throw handleHDBError(
				new Error(),
				HDB_ERROR_MSGS.TABLE_NOT_FOUND(table.databaseid, table.tableid),
				HTTP_STATUS_CODES.NOT_FOUND
			);
		}

		//let theTable = clone(table);
		let schemaTable = databases[table.databaseid][table.tableid];
		/*TODO rather than putting every attribute in an array we will create a Map there will be a map element for every table and every table alias
 (this will create duplicate map elements) this will have downstream effects in comparison functions like findColumn*/
		schemaTable.attributes.forEach((attribute) => {
			let attributeClone = clone(attribute);
			attributeClone.table = clone(table);
			this.attributes.push(attributeClone);
		});
	}

	/**
	 * validates the column against the schema
	 * @param column
	 * @returns {*[]}
	 */
	[findColumn](column) {
		//look to see if this attribute exists on one of the tables we are selecting from
		return this.attributes.filter((attribute) => {
			if (column.tableid) {
				return (
					(attribute.table.as === column.tableid || attribute.table.tableid === column.tableid) &&
					attribute.attribute === column.columnid
				);
			} else {
				return attribute.attribute === column.columnid;
			}
		});
	}

	/**
	 * detects * in the select, if found adds all columns to the select
	 */
	[checkColumnsForAsterisk]() {
		let iterator = new RecursiveIterator(this.statement.columns);

		for (let { node, path } of iterator) {
			//we check the path to make sure the '*' is not wrapped in some form of expression like count(*)
			if (node && node.columnid === '*' && path.indexOf('expression') < 0) {
				this[setColumnsForTable](node.tableid);
			}
		}
	}

	/**
	 * takes a table and adds all of it's columns to the select. if no table it adds every column from every table in the select
	 * @param tableName
	 */
	[setColumnsForTable](tableName) {
		this.attributes.forEach((attribute) => {
			if (
				(!tableName || (tableName && (attribute.table.tableid === tableName || attribute.table.as === tableName))) &&
				!attribute.relation
			) {
				this.statement.columns.push(
					new alasql.yy.Column({
						columnid: attribute.attribute,
						tableid: attribute.table.as ? attribute.table.as : attribute.table.tableid,
					})
				);
			}
		});
	}

	/**
	 * passes segments to ValidateSegment for validation
	 */
	[validateAllColumns]() {
		this[validateSegment](this.statement.columns, false);
		this[validateSegment](this.statement.joins, false);
		this[validateSegment](this.statement.where, false);
		this[validateGroupBy](this.statement.group, false);
		this[validateSegment](this.statement.order, true);
	}

	/**
	 * iterates the attributes in a segment and validates them against the schema
	 * @param segment
	 * @param isOrderBy
	 * @returns {*}
	 */
	[validateSegment](segment, isOrderBy) {
		if (!segment) {
			return;
		}

		let iterator = new RecursiveIterator(segment);
		let attributes = [];
		for (let { node, path } of iterator) {
			if (!commonUtils.isEmpty(node) && !commonUtils.isEmpty(node.columnid) && node.columnid !== '*') {
				if (isOrderBy) {
					this[validateOrderBy](node);
				} else {
					attributes.push(this[validateColumn](node));
				}
			}
		}

		return attributes;
	}

	/**
	 * validation specific for GROUP BY
	 * makes sure that the non-aggregate functions and columns from the select are represented in the group by and the columns match the schema
	 * @param segment
	 */
	[validateGroupBy](segment) {
		if (!segment) {
			return;
		}
		//check select for aggregates and non-aggregates, if it has both non-aggregates need to be in group by
		let selectColumns = [];
		//here we are pulling out all non-aggregate functions into an array for comparison to the group by
		this.statement.columns.forEach((column) => {
			//this keeps white listed custom functions from being validated
			if (column.funcid && customAggregators.indexOf(column.funcid.toUpperCase()) >= 0) {
				return;
			}

			if (!column.aggregatorid && !column.columnid) {
				//this is to make sure functions or any type of evaluation statement is being compared to the select.
				//i.e. "GROUP BY UPPER(name)" needs to have UPPER(name) in the select
				let columnClone = clone(column);
				delete columnClone.as;
				selectColumns.push(columnClone);
			} else if (column.columnid) {
				let found = this[findColumn](column)[0];
				if (found) {
					selectColumns.push(found);
				}
			}
		});

		//here we iterate the group by and compare to what is in the select and make sure they match appropriately
		this.statement.group.forEach((groupColumn) => {
			let foundColumn = null;

			if (!groupColumn.columnid) {
				//TODO can use for of to break out of the loop rather than this janky way
				selectColumns.forEach((column, x) => {
					if (column.toString() === groupColumn.toString()) {
						foundColumn = column;
						selectColumns.splice(x, 1);
						return;
					}
				});
			} else {
				let foundGroupColumn = this[findColumn](groupColumn);

				if (!foundGroupColumn || foundGroupColumn.length === 0) {
					throw `unknown column '${group_column.toString()}' in group by`;
				}

				if (foundGroupColumn.length > 1) {
					throw `ambiguously defined column '${group_column.toString()}' in group by`;
				}

				//TODO can use for of to break out of the loop rather than this janky way
				selectColumns.forEach((column, x) => {
					if (
						column.attribute === foundGroupColumn[0].attribute &&
						column.table.tableid === foundGroupColumn[0].table.tableid
					) {
						foundColumn = column;
						selectColumns.splice(x, 1);
						return;
					}
				});
			}

			if (!foundColumn) {
				throw `group by column '${group_column.toString()}' must be in select`;
			}
		});

		if (selectColumns.length > 0) {
			throw `select column '${
				selectColumns[0].attribute ? selectColumns[0].attribute : selectColumns[0].toString()
			}' must be in group by`;
		}
	}

	/**
	 * Order BY specific validation
	 *
	 * @param column
	 */
	[validateOrderBy](column) {
		let foundColumns = this.statement.columns.filter((col) => col.as === column.columnid);

		if (foundColumns.length > 1) {
			let columnName = (column.tableid ? column.tableid + '.' : '') + column.columnid;
			throw `ambiguous column reference ${columnName} in order by`;
		} else if (foundColumns.length === 0) {
			this[validateColumn](column);
		}
	}

	/**
	 * validates a column to the schema
	 * @param column
	 * @returns {*}
	 */
	[validateColumn](column) {
		let foundColumns = this[findColumn](column);

		let columnName = (column.tableid ? column.tableid + '.' : '') + column.columnid;

		if (foundColumns.length === 0) {
			throw `unknown column ${columnName}`;
		}

		if (foundColumns.length > 1) {
			throw `ambiguous column reference ${columnName}`;
		}

		return foundColumns[0];
	}
}

module.exports = SelectValidator;
