'use strict';

/**
 * SQLSearch.js
 * This class is used to receive the alasql generated AST from a SQL SELECT,
 * process and return results by passing the raw values into the alasql SQL parser
 */

const _ = require('lodash');
const alasql = require('alasql');
alasql.options.cache = false;
const alasqlFunctionImporter = require('../sqlTranslator/alasqlFunctionImporter.js');
const clone = require('clone');
const RecursiveIterator = require('recursive-iterator');
const log = require('../utility/logging/harper_logger.js');
const commonUtils = require('../utility/common_utils.js');
const harperBridge = require('./harperBridge/harperBridge.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const { hdbErrors } = require('../utility/errors/hdbError.js');
const { getDatabases } = require('../resources/databases.ts');

const WHERE_CLAUSE_IS_NULL = 'IS NULL';
const SEARCH_ERROR_MSG = 'There was a problem performing this search. Please check the logs and try again.';

//here we call to define and import custom functions to alasql
alasqlFunctionImporter(alasql);

class SQLSearch {
	/**
	 * Constructor for FileSearch class
	 *
	 * @param statement - the AST for the SQL SELECT to process
	 * @param attributes - all attributes that are part of the schema for the tables in select
	 */
	constructor(statement, attributes) {
		if (commonUtils.isEmpty(statement)) {
			log.error('AST statement for SQL select process cannot be empty');
			throw 'statement cannot be null';
		}

		this.statement = statement;
		//this is every attribute that we need to pull data for
		this.columns = {};

		this.all_table_attributes = attributes;

		this.fetch_attributes = [];
		this.exact_search_values = {};
		this.comparator_search_values = {};
		this.tables = [];

		//holds the data to be evaluated by the sql processor
		this.data = {};

		this.has_aggregator = false;
		this.has_ordinal = false;
		this.has_outer_join = false;

		this._getColumns();
		this._getTables();
		this._conditionsToFetchAttributeValues();
		this._setAliasesForColumns();
		commonUtils.backtickASTSchemaItems(this.statement);
	}

	/**
	 * Starting point function to execute the search
	 * @returns {Promise<results|finalResults[]|Array>}
	 */
	async search() {
		let searchResults = undefined;
		try {
			let emptySqlResults = await this._checkEmptySQL();
			if (!commonUtils.isEmptyOrZeroLength(emptySqlResults)) {
				log.trace('No results returned from checkEmptySQL SQLSearch method.');
				return emptySqlResults;
			}
		} catch (err) {
			log.error('Error thrown from checkEmptySQL in SQLSearch class method search.');
			log.error(err);
			throw new Error(SEARCH_ERROR_MSG);
		}

		try {
			// Search for fetch attribute values and consolidate them into this.data[table].__mergedData property
			const simpleQueryResults = await this._getFetchAttributeValues();
			if (simpleQueryResults) {
				return simpleQueryResults;
			}
		} catch (err) {
			log.error('Error thrown from getFetchAttributeValues in SQLSearch class method search.');
			log.error(err);
			throw new Error(SEARCH_ERROR_MSG);
		}

		// In the instance of null data this.data would not have schema/table defined or created as there is no data backing up what would sit in data.
		if (Object.keys(this.data).length === 0) {
			log.trace('SQLSearch class field: "data" is empty.');
			return [];
		}

		let joinResults;
		try {
			// Consolidate initial data required for first pass of sql join - narrows list of hash ids for second pass to collect all data resulting from sql request
			joinResults = await this._processJoins();
		} catch (err) {
			log.error('Error thrown from processJoins in SQLSearch class method search.');
			log.error(err);
			throw new Error(SEARCH_ERROR_MSG);
		}

		try {
			// Decide the most efficient way to make the second/final pass for collecting all additional data needed for sql request
			await this._getFinalAttributeData(joinResults.existing_attributes, joinResults.joined_length);
		} catch (err) {
			log.error('Error thrown from getFinalAttributeData in SQLSearch class method search.');
			log.error(err);
			throw new Error(SEARCH_ERROR_MSG);
		}

		try {
			searchResults = await this._finalSQL();
			return searchResults;
		} catch (err) {
			log.error('Error thrown from finalSQL in SQLSearch class method search.');
			log.error(err);
			throw new Error(SEARCH_ERROR_MSG);
		}
	}

	/**
	 * Gets the raw column from each section of the statement and puts them in a map
	 * @private
	 */
	_getColumns() {
		let iterator = new RecursiveIterator(this.statement);
		for (let { node, path } of iterator) {
			if (node && node.columnid) {
				if (!this.columns[path[0]]) {
					this.columns[path[0]] = [];
				}
				this.columns[path[0]].push(clone(node));
			}
		}
	}

	/**
	 * Extracts the table info from the attributes
	 * @private
	 */
	_getTables() {
		let tbls = [];
		this.all_table_attributes.forEach((attribute) => {
			tbls.push(attribute.table);
		});

		this.tables = _.uniqBy(tbls, (tbl) => [tbl.databaseid, tbl.tableid, tbl.as].join());
		this.tables.forEach((table) => {
			const schemaTable = `${table.databaseid}_${table.as ? table.as : table.tableid}`;
			this.data[schemaTable] = {};
			this.data[schemaTable].__hashName = getDatabases()[table.databaseid][table.tableid].primaryKey;
			this.data[schemaTable].__mergedData = {};
			this.data[schemaTable].__mergedAttributes = [];
			this.data[schemaTable].__mergedAttrMap = {};
		});
	}

	/**
	 * Iterates the where AST with the goal of finding exact values to match directly on. Matching on values allows us to skip parsing an index
	 * If a condition has a columnid, and op of '=' or 'IN' and only is comparing to raw values we will limit the column to the raw value match.
	 * If a column condition does not have these criteria or another condition for the same column does not adhere to the criteria then we ignore it for exact matching.
	 * @private
	 */
	_conditionsToFetchAttributeValues() {
		//TODO - CORE-1095 - update how WHERE clause value that include escaped characters is used to do initial
		// searchByValue query - this value is set to this.exact_search_values in this method
		if (commonUtils.isEmpty(this.statement.where)) {
			log.trace('AST "where" statement is empty.');
			return;
		}

		//if there is an OR in the where clause we will not perform exact match search on attributes as it ends up excluding values incorrectly.
		let totalIgnore = false;

		//check for OR statement (see not above) and update numeric hash values set as strings in the statement to evaluate the table data
		// correctly as numbers in alasql which evaluates based on data types
		for (let { node } of new RecursiveIterator(this.statement.where)) {
			if (node && node.op && node.op === 'OR') {
				totalIgnore = true;
			}
			if (!commonUtils.isEmpty(node) && node.right) {
				if (commonUtils.isNotEmptyAndHasValue(node.right.value)) {
					const whereVal = commonUtils.autoCast(node.right.value);
					if ([true, false].indexOf(whereVal) >= 0) {
						node.right = new alasql.yy.LogicValue({ value: whereVal });
					}
				} else if (Array.isArray(node.right)) {
					node.right.forEach((col, i) => {
						const whereVal = commonUtils.autoCast(col.value);
						if ([true, false].indexOf(whereVal) >= 0) {
							node.right[i] = new alasql.yy.LogicValue({ value: whereVal });
						} else if (
							col instanceof alasql.yy.StringValue &&
							commonUtils.autoCasterIsNumberCheck(whereVal.toString())
						) {
							node.right[i] = new alasql.yy.NumValue({ value: whereVal });
						}
					});
				}
			}
		}

		if (totalIgnore) {
			log.trace('Where clause contains "OR", exact match search not performed on attributes.');
			return;
		}

		for (let { node } of new RecursiveIterator(this.statement.where)) {
			if (node && node.left && node.right && (node.left.columnid || node.right.value) && node.op) {
				let values = new Set();
				let column = node.left.columnid ? node.left : node.right;
				let foundColumn = this._findColumn(column);
				if (!foundColumn) {
					continue;
				}
				//Specifically a slash delimited string for consistency
				let attributeKey = [foundColumn.table.databaseid, foundColumn.table.tableid, foundColumn.attribute].join('/');

				// Check for value range search first
				if (!commonUtils.isEmpty(hdbTerms.VALUE_SEARCH_COMPARATORS_REVERSE_LOOKUP[node.op])) {
					if (commonUtils.isEmpty(this.comparator_search_values[attributeKey])) {
						this.comparator_search_values[attributeKey] = {
							ignore: false,
							comparators: [],
						};
					}

					if (!this.comparator_search_values[attributeKey].ignore) {
						if (
							commonUtils.isEmptyOrZeroLength(node.left.columnid) ||
							commonUtils.isEmptyOrZeroLength(node.right.value)
						) {
							this.comparator_search_values[attributeKey].ignore = true;
							this.comparator_search_values[attributeKey].comparators = [];
							continue;
						}

						this.comparator_search_values[attributeKey].comparators.push({
							attribute: node.left.columnid,
							operation: node.op,
							value: node.right.value,
						});
					}
					continue;
				}

				if (commonUtils.isEmpty(this.exact_search_values[attributeKey])) {
					this.exact_search_values[attributeKey] = {
						ignore: false,
						values: new Set(),
					};
				}

				if (!this.exact_search_values[attributeKey].ignore) {
					let ignore = false;

					switch (node.op) {
						case '=':
							if (!commonUtils.isEmpty(node.right.value) || !commonUtils.isEmpty(node.left.value)) {
								values.add(!commonUtils.isEmpty(node.right.value) ? node.right.value : node.left.value);
							} else {
								ignore = true;
							}
							break;
						case 'IN':
							let inArray = Array.isArray(node.right) ? node.right : node.left;

							for (let x = 0; x < inArray.length; x++) {
								if (inArray[x].value) {
									values.add(inArray[x].value);
								} else {
									ignore = true;
									break;
								}
							}
							break;
						default:
							ignore = true;
							break;
					}
					this.exact_search_values[attributeKey].ignore = ignore;

					//if we are ignoring the column for exact matches we clear out it's values to match later
					if (ignore) {
						this.exact_search_values[attributeKey].values = new Set();
					} else {
						this.exact_search_values[attributeKey].values = new Set([
							...this.exact_search_values[attributeKey].values,
							...values,
						]);
					}
				}
			}
		}
	}

	/**
	 * Iterates the columns in the AST and assigns an alias to each column if one does not exist.  This is necessary to ensure
	 * that the final result returned from alasql include the correct column header
	 * @private
	 */
	_setAliasesForColumns() {
		//this scenario is reached by doing a select with only calculations and, therefore, this step can be skipped.
		if (
			commonUtils.isEmptyOrZeroLength(this.all_table_attributes) &&
			commonUtils.isEmptyOrZeroLength(this.statement.from) &&
			commonUtils.isEmptyOrZeroLength(this.columns.columns)
		) {
			return;
		}
		let wildcardIndexes = [];
		let dupAttrCount = {};
		this.statement.columns.forEach((col, index) => {
			if (col.columnid === '*') {
				wildcardIndexes.push(index);
				return;
			}

			if (col.aggregatorid) {
				this.has_aggregator = true;
			}

			if (!col.aggregatorid && !col.funcid) {
				col.as_orig = col.as ? col.as : col.columnid;
				if (this.statement.joins) {
					if (dupAttrCount[col.as_orig] >= 0) {
						const attrCount = dupAttrCount[col.as_orig] + 1;
						col.as = `[${col.as_orig + attrCount}]`;
						dupAttrCount[col.as_orig] = attrCount;
					} else {
						col.as = `[${col.as_orig}]`;
						dupAttrCount[col.as_orig] = 0;
					}
				} else {
					col.as = `[${col.as_orig}]`;
				}
			}

			if (!col.aggregatorid && col.funcid && col.args) {
				col.as_orig = col.as ? col.as : col.toString().replace(/'/g, '"');
				col.as = `[${col.as_orig}]`;
			}

			if (col.aggregatorid && col.expression.columnid !== '*') {
				col.as_orig = col.as
					? col.as
					: col.expression.tableid
						? `${col.aggregatorid}(${col.expression.tableid}.${col.expression.columnid})`
						: `${col.aggregatorid}(${col.expression.columnid})`;
				col.as = `[${col.as_orig}]`;
			}
		});

		if (this.statement.columns.length > 1 && wildcardIndexes.length > 0) {
			_.pullAt(this.statement.columns, wildcardIndexes);
		}
	}

	/**
	 * Searches the attributes for the matching column based on attribute & table name/alias
	 *
	 * @param column - the column to search for
	 * @returns {foundColumns}
	 * @private
	 */
	_findColumn(column) {
		//look to see if this attribute exists on one of the tables we are selecting from
		let foundColumns = this.all_table_attributes.filter((attribute) => {
			if (column.columnid_orig && column.tableid_orig) {
				return (
					(attribute.table.as === column.tableid_orig || attribute.table.tableid === column.tableid_orig) &&
					attribute.attribute === column.columnid_orig
				);
			}

			if (column.tableid) {
				return (
					(attribute.table.as === column.tableid || attribute.table.tableid === column.tableid) &&
					attribute.attribute === column.columnid
				);
			}

			const colName = column.columnid_orig ? column.columnid_orig : column.columnid;
			return attribute.attribute === colName;
		});

		//this is to handle aliases.  if we did not find the actual column we look at the aliases in the select columns and then return the matching column from allTableAttrs, if it exists
		if (commonUtils.isEmptyOrZeroLength(foundColumns)) {
			const foundAlias = this.columns.columns.filter((selectColumn) =>
				selectColumn.as ? column.columnid === selectColumn.as : false
			);
			if (!commonUtils.isEmptyOrZeroLength(foundAlias)) {
				foundColumns = this.all_table_attributes.filter(
					(col) =>
						col.attribute === foundAlias[0].columnid &&
						foundAlias[0].tableid &&
						foundAlias[0].tableid === (col.table.as ? col.table.as : col.table.tableid)
				);
			}
		}

		return foundColumns[0];
	}

	/**
	 * This function check to see if there is no from and no columns, or the table has been created but no data has been entered yet
	 * if there are not then this is a SELECT used to solely perform a calculation such as SELECT 2*4, or SELECT SQRT(4)
	 * @returns {Promise<[]>}
	 * @private
	 */
	async _checkEmptySQL() {
		let results = [];
		//the scenario that allows this to occur is the table has been created but no data has been entered yet, in this case we return an empty array
		if (
			commonUtils.isEmptyOrZeroLength(this.all_table_attributes) &&
			!commonUtils.isEmptyOrZeroLength(this.columns.columns)
		) {
			//purpose of this is to break out of the waterfall but return an empty array
			return results;
		} else if (
			commonUtils.isEmptyOrZeroLength(this.all_table_attributes) &&
			commonUtils.isEmptyOrZeroLength(this.statement.from)
		) {
			//this scenario is reached by doing a select with only calculations
			try {
				let sql = this._buildSQL(false);
				results = await alasql.promise(sql);
			} catch (e) {
				log.error('Error thrown from AlaSQL in SQLSearch class method checkEmptySQL.');
				log.error(e);
				throw new Error('There was a problem with the SQL statement');
			}
		}
		return results;
	}

	/**
	 * Iterates an ast segment columns and returns the found column.  Typically fetch columns are columns specified in a
	 * join, where, or orderby clause.
	 * @param segmentAttributes
	 * @private
	 */
	_addFetchColumns(segmentAttributes) {
		if (segmentAttributes && segmentAttributes.length > 0) {
			segmentAttributes.forEach((attribute) => {
				let found = this._findColumn(attribute);
				if (found) {
					this.fetch_attributes.push(clone(found));
				}
			});
		}
	}

	/**
	 * Adds new attribute metadata for the specified table to enable more easily accessing/adding/updating row data being built out
	 * @param schemaTable <String> the table to add the metadata to
	 * @param attr <String> the attribute to add to the table row metadata
	 * @private
	 */
	_addColumnToMergedAttributes(schemaTable, attr) {
		this.data[schemaTable].__mergedAttributes.push(attr);
		this.data[schemaTable].__mergedAttrMap[attr] = this.data[schemaTable].__mergedAttributes.length - 1;
	}

	/**
	 * Adds the hash attribute to the specified table - this is similar to the above but unique for hash attributes because we always
	 * add hash keys to the first index position in the table metadata and do not need to add it to the `__mergedAttrMap`
	 * @param schemaTable <String> the table to add the metadata to
	 * @param hashValue <String> the hash key to add to the table row metadata
	 * @private
	 */
	_setMergedHashAttribute(schemaTable, hashValue) {
		this.data[schemaTable].__mergedData[hashValue].splice(0, 1, hashValue);
	}

	/**
	 * Updates the table row data for a specific hash value
	 * @param schemaTable <String> the table to update the hash value row in
	 * @param hashValue <String> the hash value to update an attr for
	 * @param attr <String> the attr to update in the table row
	 * @param updateValue <String> the value to update in the table row
	 * @private
	 */
	_updateMergedAttribute(schemaTable, hashValue, attr, updateValue) {
		const attrIndex = this.data[schemaTable].__mergedAttrMap[attr];
		this.data[schemaTable].__mergedData[hashValue].splice(attrIndex, 1, updateValue);
	}

	/**
	 * Gets all values for the where, join, & order by attributes and converts the raw indexed data into individual
	 * rows by hash attribute consolidated based on tables. If the SQL statement is a simple SELECT query, this method
	 * will return the results from that select and bypass the additional alasql steps.
	 * @returns {Promise<void>}
	 * @private
	 */
	async _getFetchAttributeValues() {
		//If there are no columns in the AST at this point, it means that this query was a select * on a table that the
		// user had read access to but has no access to read any of the attributes so we just return empty results.
		if (commonUtils.isEmptyOrZeroLength(Object.keys(this.columns))) {
			return [];
		}
		//get all unique attributes
		this._addFetchColumns(this.columns.joins);

		let whereString = null;
		try {
			whereString = this.statement.where ? this.statement.where.toString() : '';
		} catch (e) {
			throw new Error('Could not generate proper where clause');
		}
		if (this.columns.where) {
			this._addFetchColumns(this.columns.where);
		}

		//We need to check if statement only includes basic columns and a from value in the statement
		// - if so, cannot treat as a simple select query and need to run through alasql
		const simpleSelectQuery = this._isSimpleSelect();
		if (simpleSelectQuery) {
			this._addFetchColumns(this.columns.columns);
		}
		//the bitwise or '|' is intentionally used because I want both conditions checked regardless of whether the left condition is false
		else if (
			(!this.columns.where && this.fetch_attributes.length === 0) |
			(whereString.indexOf(WHERE_CLAUSE_IS_NULL) > -1)
		) {
			//get unique ids of tables if there is no join or the where is performing an is null check
			this.tables.forEach((table) => {
				let hash_attribute = {
					columnid: getDatabases()[table.databaseid][table.tableid].primaryKey,
					tableid: table.tableid,
				};
				this._addFetchColumns([hash_attribute]);
			});
		}

		if (this.statement.order) {
			this._updateOrderByToAliases();
			this._addNonAggregatorsToFetchColumns();
		}

		// do we need this uniqueby, could just use object as map
		this.fetch_attributes = _.uniqBy(this.fetch_attributes, (attribute) =>
			[
				attribute.table.databaseid,
				attribute.table.as ? attribute.table.as : attribute.table.tableid,
				attribute.attribute,
			].join()
		);

		if (simpleSelectQuery) {
			return await this._simpleSQLQuery();
		}

		// create a template for each table row to ensure each row has a null value for attrs not returned in the search
		const fetchAttrRowTemplates = this.fetch_attributes.reduce((acc, attr) => {
			const schemaTable = `${attr.table.databaseid}_${attr.table.as ? attr.table.as : attr.table.tableid}`;
			const hashName = this.data[schemaTable].__hashName;

			if (!acc[schemaTable]) {
				acc[schemaTable] = [];
				acc[schemaTable].push(null);
				this._addColumnToMergedAttributes(schemaTable, hashName);
			}

			if (attr.attribute !== hashName) {
				acc[schemaTable].push(null);
				this._addColumnToMergedAttributes(schemaTable, attr.attribute);
			}

			return acc;
		}, {});

		for (const attribute of this.fetch_attributes) {
			const schemaTable = `${attribute.table.databaseid}_${
				attribute.table.as ? attribute.table.as : attribute.table.tableid
			}`;
			let hashName = this.data[schemaTable].__hashName;

			let searchObject = {
				schema: attribute.table.databaseid,
				table: attribute.table.tableid,
				get_attributes: [attribute.attribute],
			};
			let isHash = false;
			//Specifically a slash delimited string for consistency
			let objectPath = [attribute.table.databaseid, attribute.table.tableid, attribute.attribute].join('/');

			//check if this attribute is the hash attribute for a table, if it is we need to read the files from the __hdhHash
			// folder, otherwise pull from the value index
			if (attribute.attribute === hashName) {
				isHash = true;
			}

			// if there exact match values for this attribute we just assign them to the attribute, otherwise we pull the
			// index to get all values.  This query will test the if statement below
			// "sql":"select weightLbs, age, ownerName from dev.dog where ownerName = 'Kyle'"
			if (
				!commonUtils.isEmpty(this.exact_search_values[objectPath]) &&
				!this.exact_search_values[objectPath].ignore &&
				!commonUtils.isEmptyOrZeroLength(this.exact_search_values[objectPath].values)
			) {
				if (isHash) {
					try {
						searchObject.hash_values = Array.from(this.exact_search_values[objectPath].values);
						const attributeValues = await harperBridge.getDataByHash(searchObject);

						for (const hashVal of searchObject.hash_values) {
							if (attributeValues.get(hashVal) && !this.data[schemaTable].__mergedData[hashVal]) {
								this.data[schemaTable].__mergedData[hashVal] = [...fetchAttrRowTemplates[schemaTable]];
								this._setMergedHashAttribute(schemaTable, hashVal);
							}
						}
					} catch (err) {
						log.error(
							'Error thrown from getDataByHash function in SQLSearch class method getFetchAttributeValues exact match.'
						);
						log.error(err);
						throw new Error(SEARCH_ERROR_MSG);
					}
				} else {
					try {
						searchObject.attribute = attribute.attribute;
						await Promise.all(
							Array.from(this.exact_search_values[objectPath].values).map(async (value) => {
								let exactSearchObject = { ...searchObject };
								exactSearchObject.value = value;
								const attributeValues = await harperBridge.getDataByValue(exactSearchObject);

								for (const [hashVal, record] of attributeValues) {
									if (!this.data[schemaTable].__mergedData[hashVal]) {
										this.data[schemaTable].__mergedData[hashVal] = [...fetchAttrRowTemplates[schemaTable]];
										this._updateMergedAttribute(schemaTable, hashVal, attribute.attribute, record[attribute.attribute]);
										this._setMergedHashAttribute(schemaTable, hashVal);
									} else {
										this._updateMergedAttribute(schemaTable, hashVal, attribute.attribute, record[attribute.attribute]);
									}
								}
							})
						);
					} catch (err) {
						log.error(
							'Error thrown from getDataByValue function in SQLSearch class method getFetchAttributeValues exact match.'
						);
						log.error(err);
						throw new Error(SEARCH_ERROR_MSG);
					}
				}
			} else if (
				!commonUtils.isEmpty(this.comparator_search_values[objectPath]) &&
				!this.comparator_search_values[objectPath].ignore &&
				!commonUtils.isEmptyOrZeroLength(this.comparator_search_values[objectPath].comparators)
			) {
				try {
					const searchValueComparators = this.comparator_search_values[objectPath].comparators;
					for (let i = 0, len = searchValueComparators.length; i < len; i++) {
						const comp = searchValueComparators[i];
						searchObject.attribute = comp.attribute;
						searchObject.value = comp.value;
						const matchingData = await harperBridge.getDataByValue(searchObject, comp.operation);

						if (isHash) {
							for (const [hashVal] of matchingData) {
								if (!this.data[schemaTable].__mergedData[hashVal]) {
									this.data[schemaTable].__mergedData[hashVal] = [...fetchAttrRowTemplates[schemaTable]];
									this._setMergedHashAttribute(schemaTable, hashVal);
								}
							}
						} else {
							for (const [hashVal, record] of matchingData) {
								if (!this.data[schemaTable].__mergedData[hashVal]) {
									this.data[schemaTable].__mergedData[hashVal] = [...fetchAttrRowTemplates[schemaTable]];
									this._updateMergedAttribute(schemaTable, hashVal, attribute.attribute, record[attribute.attribute]);
									this._setMergedHashAttribute(schemaTable, hashVal);
								} else {
									this._updateMergedAttribute(schemaTable, hashVal, attribute.attribute, record[attribute.attribute]);
								}
							}
						}
					}
				} catch (err) {
					log.error(
						'Error thrown from getDataByValue function in SQLSearch class method getFetchAttributeValues comparator search values.'
					);
					log.error(err);
					throw new Error(SEARCH_ERROR_MSG);
				}
			} else {
				try {
					searchObject.attribute = attribute.attribute;
					searchObject.value = '*';
					const matchingData = await harperBridge.getDataByValue(searchObject);

					if (isHash) {
						for (const [hashVal] of matchingData) {
							if (!this.data[schemaTable].__mergedData[hashVal]) {
								this.data[schemaTable].__mergedData[hashVal] = [...fetchAttrRowTemplates[schemaTable]];
								this._setMergedHashAttribute(schemaTable, hashVal);
							}
						}
					} else {
						for (const [hashVal, record] of matchingData) {
							if (!this.data[schemaTable].__mergedData[hashVal]) {
								this.data[schemaTable].__mergedData[hashVal] = [...fetchAttrRowTemplates[schemaTable]];
								this._updateMergedAttribute(schemaTable, hashVal, attribute.attribute, record[attribute.attribute]);
								this._setMergedHashAttribute(schemaTable, hashVal);
							} else {
								this._updateMergedAttribute(schemaTable, hashVal, attribute.attribute, record[attribute.attribute]);
							}
						}
					}
				} catch (err) {
					log.error(
						'Error thrown from getDataByValue function in SQLSearch class method getFetchAttributeValues no comparator search values.'
					);
					log.error(err);
					throw new Error(SEARCH_ERROR_MSG);
				}
			}
		}
	}

	/**
	 * Checks if SQL statement only includes basic SELECT columns FROM one table
	 * @returns {boolean} is SQL statement a simple select
	 * @private
	 */
	_isSimpleSelect() {
		let isSimpleSelect = true;

		if (
			Object.keys(this.statement).length !== 2 ||
			!this.statement.columns ||
			!this.statement.from ||
			this.statement.from.length !== 1
		) {
			isSimpleSelect = false;
			return isSimpleSelect;
		}

		this.statement.columns.forEach((col) => {
			if (!(col instanceof alasql.yy.Column)) {
				isSimpleSelect = false;
			}
		});

		return isSimpleSelect;
	}

	/**
	 * Updates the AST order by values to utilize the aliases already set for the corresponding column values.  This is required to
	 * resolve a bug in alasql where column values/references in the order by are not parsed by the library correctly.
	 * @private
	 */
	_updateOrderByToAliases() {
		this.statement.order.forEach((orderBy) => {
			//We don't need to do anything with the alias if the orderby is an aggregator
			if (orderBy.expression.aggregatorid) {
				orderBy.is_aggregator = true;
				return;
			}

			if (orderBy.expression.value) {
				orderBy.is_ordinal = true;
				this.has_ordinal = true;
				return;
			} else {
				orderBy.is_ordinal = false;
			}

			let foundColumn = this.statement.columns.filter((col) => {
				const colExpression = col.aggregatorid ? col.expression : col;
				const colAlias = col.aggregatorid ? col.as_orig : colExpression.as_orig;

				if (!orderBy.expression.tableid) {
					return (
						colExpression.columnid_orig === orderBy.expression.columnid_orig ||
						orderBy.expression.columnid_orig === colAlias
					);
				} else {
					return (
						colExpression.columnid_orig === orderBy.expression.columnid_orig &&
						colExpression.tableid_orig === orderBy.expression.tableid_orig
					);
				}
			});

			if (!foundColumn[0]) {
				foundColumn.push(this._findColumn(orderBy.expression));
			}

			let selectColumn = foundColumn[0];

			//These values are used in later steps to help evaluate how best to treat the order by statement in our logic
			orderBy.is_func = !!selectColumn.funcid;
			orderBy.is_aggregator = !!selectColumn.aggregatorid;

			if (!selectColumn.as) {
				orderBy.initial_select_column = Object.assign(new alasql.yy.Column(), orderBy.expression);
				orderBy.initial_select_column.as = `[${orderBy.expression.columnid_orig}]`;
				orderBy.expression.columnid = orderBy.initial_select_column.as;
				return;
			} else if (selectColumn.as && !orderBy.expression.tableid) {
				orderBy.expression.columnid = selectColumn.as;
				orderBy.expression.columnid_orig = selectColumn.as_orig;
			} else {
				let aliasExpression = new alasql.yy.Column();
				aliasExpression.columnid = selectColumn.as;
				aliasExpression.columnid_orig = selectColumn.as_orig;
				orderBy.expression = aliasExpression;
			}
			if (!orderBy.is_aggregator) {
				const targetObj = orderBy.is_func ? new alasql.yy.FuncValue() : new alasql.yy.Column();
				orderBy.initial_select_column = Object.assign(targetObj, selectColumn);
			}
		});
	}

	/**
	 * This ensures that the non-aggregator columns included in the order by statement are included in the table data for the
	 * first pass of alasql
	 * @private
	 */
	_addNonAggregatorsToFetchColumns() {
		const nonAggrOrderByCols = this.statement.order.filter((ob) => !ob.is_aggregator && !ob.is_ordinal);
		const nonAggrColumnids = nonAggrOrderByCols.map((ob) => {
			if (ob.is_func) {
				const colIdArg = ob.initial_select_column.args.filter((arg) => !!arg.columnid_orig);
				return { columnid: colIdArg[0].columnid_orig };
			} else {
				return { columnid: ob.expression.columnid_orig };
			}
		});
		this._addFetchColumns(nonAggrColumnids);
	}

	/**
	 * Takes an initial pass on the data by processing just the joins, conditions and order by.
	 * This allows us to limit the broader select based on just the ids we need based on this pass
	 * @returns {Promise<{existingAttributes, joined_length: number}>}
	 * @private
	 */
	async _processJoins() {
		let tableData = [];
		let select = [];
		//TODO need to loop from here to ensure cross joins are covered - i.e. 'from tablea a, tableb b, tablec c' -
		// this is not high priority but is covered in CORE-894
		let fromStatement = this.statement.from[0];
		let tables = [fromStatement];
		let fromClause = ['? ' + (fromStatement.as ? ' AS ' + fromStatement.as : fromStatement.tableid)];

		tableData.push(
			Object.values(
				this.data[
					`${fromStatement.databaseid_orig}_${fromStatement.as ? fromStatement.as_orig : fromStatement.tableid_orig}`
				].__mergedData
			)
		);

		if (this.statement.joins) {
			this.statement.joins.forEach((join) => {
				if (join.joinmode && join.joinmode !== 'INNER') {
					this.has_outer_join = true;
				}
				tables.push(join.table);
				let from = join.joinmode + ' JOIN ? AS ' + (join.as ? join.as : join.table.tableid);

				if (join.on) {
					from += ' ON ' + join.on.toString();
				}
				fromClause.push(from);

				tableData.push(
					Object.values(
						this.data[`${join.table.databaseid_orig}_${join.table.as ? join.table.as_orig : join.table.tableid_orig}`]
							.__mergedData
					)
				);
			});
		}

		//record the fetched attributes so we can compare to what else needs to be grabbed
		let hashAttributes = [];
		let existingAttributes = {};
		tables.forEach((table) => {
			let hash = this.data[`${table.databaseid_orig}_${table.as ? table.as_orig : table.tableid_orig}`].__hashName;
			const tableKey = table.as ? table.as_orig : table.tableid_orig;
			hashAttributes.push({
				key: `'${tableKey}.${hash}'`,
				schema: table.databaseid_orig,
				table: table.as ? table.as_orig : table.tableid_orig,
				keys: new Set(),
			});
			select.push(`${table.as ? table.as : table.tableid}.\`${hash}\` AS "${tableKey}.${hash}"`);

			existingAttributes[table.as ? table.as_orig : table.tableid_orig] =
				this.data[`${table.databaseid_orig}_${table.as ? table.as_orig : table.tableid_orig}`].__mergedAttributes;
		});

		//TODO there is an error with between statements being converted back to string.  need to handle
		//TODO - CORE-1095 - update how WHERE clause is translated back to SQL query for where expression values include escaped characters
		let whereClause = this.statement.where ? 'WHERE ' + this.statement.where : '';
		whereClause = whereClause.replace(/NOT\(NULL\)/g, 'NOT NULL');

		let orderClause = '';
		//the only time we need to include the order by statement in the first pass is when there are no aggregators,
		// no ordinals in order by, and/or no group by statements AND there is a LIMIT because final sorting will be done on
		// the data that is returned from the 2nd alasql pass
		if (
			this.statement.order &&
			!this.has_ordinal &&
			!this.has_aggregator &&
			!this.statement.group &&
			this.statement.limit
		) {
			orderClause = 'ORDER BY ' + this.statement.order.toString();
			//because of the alasql bug with orderby (CORE-929), we need to add the ORDER BY column to the select with the
			// alias to ensure it's available for sorting in the first pass
			this.statement.order.forEach((ob) => {
				if (ob.is_func) {
					select.push(ob.initial_select_column.toString());
				} else if (ob.initial_select_column.tableid) {
					select.push(
						`${ob.initial_select_column.tableid}.${ob.initial_select_column.columnid} AS ${ob.expression.columnid}`
					);
				} else {
					select.push(`${ob.initial_select_column.columnid} AS ${ob.expression.columnid}`);
				}
			});
		}

		let limit = '';
		let offset = '';
		if (!this.has_aggregator && !this.statement.group && !this.has_ordinal && !this.statement.joins) {
			limit = this.statement.limit ? 'LIMIT ' + this.statement.limit : '';
			offset = this.statement.offset ? 'OFFSET ' + this.statement.offset : '';
		}

		let joined = [];

		try {
			const initialSql = `SELECT ${select.join(', ')} FROM ${fromClause.join(
				' '
			)} ${whereClause} ${orderClause} ${limit} ${offset}`;
			const finalSqlOperation = this._convertColumnsToIndexes(initialSql, tables);
			joined = await alasql.promise(finalSqlOperation, tableData);
			tableData = null;
		} catch (err) {
			log.error('Error thrown from AlaSQL in SQLSearch class method processJoins.');
			log.error(err);
			throw new Error('There was a problem processing the data.');
		}

		//collect returned hash values and remove others from table's __mergedData
		if (joined && joined.length > 0) {
			for (let i = 0, len = joined.length; i < len; i++) {
				const row = joined[i];
				hashAttributes.forEach((hash) => {
					if (row[hash.key] !== null && row[hash.key] !== undefined) {
						hash.keys.add(row[hash.key]);
					}
				});
			}

			hashAttributes.forEach((hash) => {
				let keys = Object.keys(this.data[`${hash.schema}_${hash.table}`].__mergedData);
				let deleteKeys = _.difference(
					keys,
					[...hash.keys].map((key) => key.toString())
				);
				for (let i = 0, len = deleteKeys.length; i < len; i++) {
					const key = deleteKeys[i];
					delete this.data[`${hash.schema}_${hash.table}`].__mergedData[key];
				}
			});
		}
		return {
			existing_attributes: existingAttributes,
			joined_length: joined ? joined.length : 0,
		};
	}

	/**
	 * Gets remaining attribute values for final SQL operation that were not grabbed during first pass
	 * @param existingAttributes
	 * @param rowCount
	 * @returns {Promise<void>}
	 * @private
	 */
	async _getFinalAttributeData(existingAttributes, rowCount) {
		if (rowCount === 0) {
			return;
		}

		let allColumns = [];
		let iterator = new RecursiveIterator(this.columns);
		for (let { node } of iterator) {
			if (node && node.columnid) {
				let found = this._findColumn(node);
				if (found) {
					let tableKey = found.table.as ? found.table.as : found.table.tableid;
					if (!existingAttributes[tableKey] || existingAttributes[tableKey].indexOf(found.attribute) < 0) {
						allColumns.push(found);
					}
				}
			}
		}

		allColumns = _.uniqBy(allColumns, (attribute) =>
			[
				attribute.table.databaseid,
				attribute.table.as ? attribute.table.as : attribute.table.tableid,
				attribute.attribute,
			].join()
		);

		try {
			await this._getData(allColumns);
		} catch (e) {
			log.error('Error thrown from getData in SQLSearch class method getFinalAttributeData.');
			log.error(e);
			throw new Error(SEARCH_ERROR_MSG);
		}
	}

	/**
	 * Organizes the final data searches based on tables being search to ensure we are only searching each table once
	 * @param allColumns - remaining columns to be searched in
	 * @returns {Promise<void>}
	 * @private
	 */
	async _getData(allColumns) {
		try {
			const tableSearches = allColumns.reduce((acc, column) => {
				const tableKey = `${column.table.databaseid}_${column.table.as ? column.table.as : column.table.tableid}`;
				if (!acc[tableKey]) {
					acc[tableKey] = {
						schema: column.table.databaseid,
						table: column.table.tableid,
						columns: [column.attribute],
					};
				} else {
					acc[tableKey].columns.push(column.attribute);
				}
				return acc;
			}, {});

			for (const schemaTable in tableSearches) {
				const table = tableSearches[schemaTable];
				const mergedData = this.data[schemaTable].__mergedData;
				const mergedHashKeys = [];
				for (let key in mergedData) {
					mergedHashKeys.push(mergedData[key][0]);
				}
				//we do not need to update the mergedAttrMap values here b/c we will use the index value from
				// __mergedAttributes when do the final translation of the SQL statement
				this.data[schemaTable].__mergedAttributes.push(...table.columns);

				const searchObject = {
					schema: table.schema,
					table: table.table,
					hash_values: mergedHashKeys,
					get_attributes: table.columns,
				};

				const searchResult = await harperBridge.getDataByHash(searchObject);
				const tableColsLength = table.columns.length;

				for (let i = 0, len = mergedHashKeys.length; i < len; i++) {
					const theId = mergedHashKeys[i];
					const theRow = searchResult.get(theId);
					for (let j = 0; j < tableColsLength; j++) {
						const val = table.columns[j];
						const attrVal = theRow[val] === undefined ? null : theRow[val];
						this.data[schemaTable].__mergedData[theId].push(attrVal);
					}
				}
			}
		} catch (e) {
			log.error('Error thrown from getDataByHash function in SQLSearch class method getData.');
			log.error(e);
			throw e;
		}
	}

	/**
	 * Takes all of the raw data and executes the full SQL from the AST against the data.
	 * @returns {Promise<[finalResults]>}
	 * @private
	 */
	async _finalSQL() {
		let tableData = [];
		//TODO need to loop from here to ensure cross joins are covered - i.e. 'from tablea a, tableb b, tablec c' -
		// this is not high priority but is covered in CORE-894
		let fromStatement = this.statement.from[0];
		tableData.push(
			Object.values(
				this.data[
					`${fromStatement.databaseid_orig}_${fromStatement.as ? fromStatement.as_orig : fromStatement.tableid_orig}`
				].__mergedData
			)
		);
		fromStatement.as = fromStatement.as ? fromStatement.as : fromStatement.tableid;
		fromStatement.databaseid = '';
		fromStatement.tableid = '?';

		if (this.statement.joins) {
			this.statement.joins.forEach((join) => {
				join.as = join.as ? join.as : join.table.tableid;

				tableData.push(
					Object.values(
						this.data[`${join.table.databaseid_orig}_${join.table.as ? join.table.as_orig : join.table.tableid_orig}`]
							.__mergedData
					)
				);
				join.table.databaseid = '';
				join.table.tableid = '?';
			});
		}

		if (this.statement.order) {
			this.statement.order.forEach((ob) => {
				if (ob.is_ordinal) {
					return;
				}
				const found = this.statement.columns.filter((col) => {
					const colExpression = col.aggregatorid ? col.expression : col;
					const colAlias = col.aggregatorid ? col.as_orig : colExpression.as_orig;

					if (!ob.expression.tableid) {
						return (
							colExpression.columnid_orig === ob.expression.columnid_orig || ob.expression.columnid_orig === colAlias
						);
					} else {
						return (
							colExpression.columnid_orig === ob.expression.columnid_orig &&
							colExpression.tableid_orig === ob.expression.tableid_orig
						);
					}
				});

				if (found.length === 0) {
					ob.expression.columnid = ob.initial_select_column.columnid;
				}
			});
		}

		//if we processed the offset in first sql pass it will force it again which will cause no records to be returned
		// this deletes the offset and also the limit if they were already run in the first pass
		if (
			!this.has_aggregator &&
			!this.statement.group &&
			!this.has_ordinal &&
			this.statement.limit &&
			!this.statement.joins
		) {
			delete this.statement.limit;
			delete this.statement.offset;
		}

		let finalResults = undefined;
		try {
			let sql = this._buildSQL();
			log.trace(`Final SQL: ${sql}`);
			finalResults = await alasql.promise(sql, tableData);
			if (this.has_outer_join) {
				finalResults = this._translateUndefinedValues(finalResults);
			}
			log.trace(`Final AlaSQL results data included ${finalResults.length} rows`);
		} catch (err) {
			log.error('Error thrown from AlaSQL in SQLSearch class method finalSQL.');
			log.error(err);
			throw new Error('There was a problem running the generated sql.');
		}

		return finalResults;
	}

	_translateUndefinedValues(data) {
		try {
			let finalData = [];
			for (const row of data) {
				let finalRow = Object.create(null);
				Object.keys(row).forEach((key) => {
					if (row[key] === undefined) {
						finalRow[key] = null;
					} else {
						finalRow[key] = row[key];
					}
				});
				finalData.push(finalRow);
			}
			return finalData;
		} catch (e) {
			log.error(hdbErrors.HDB_ERROR_MSGS.OUTER_JOIN_TRANSLATION_ERROR);
			log.trace(e.stack);
			return data;
		}
	}

	/**
	 * There is a bug in alasql where functions with aliases get their alias duplicated in the sql string.
	 * we need to parse out the duplicate and replace with an empty string
	 * @returns {string}
	 * @private
	 */
	_buildSQL(callConvertToIndexes = true) {
		let sql = this.statement.toString();
		sql = sql.replace(/NOT\(NULL\)/g, 'NOT NULL');

		this.statement.columns.forEach((column) => {
			if (column.funcid && column.as) {
				let columnString = column.toString().replace(' AS ' + column.as, '');
				sql = sql.replace(column.toString(), columnString);
			}
		});

		if (callConvertToIndexes === true) {
			return this._convertColumnsToIndexes(sql, this.tables);
		}

		return sql;
	}

	/**
	 * Updates the sqlStatment string to use index values instead of table column names
	 * @param sqlStatement
	 * @param tables
	 * @returns {*}
	 * @private
	 */
	_convertColumnsToIndexes(sqlStatement, tables) {
		let finalSql = sqlStatement;
		const tablesMap = {};
		tables.forEach((table) => {
			if (table.databaseid_orig) {
				tablesMap[`${table.databaseid_orig}_${table.as ? table.as_orig : table.tableid_orig}`] = table.as
					? table.as
					: table.tableid;
			} else {
				tablesMap[`${table.databaseid}_${table.as ? table.as : table.tableid}`] = `\`${
					table.as ? table.as : table.tableid
				}\``;
			}
		});
		for (const schemaTable in this.data) {
			this.data[schemaTable].__mergedAttributes.forEach((attr, index) => {
				const table = tablesMap[schemaTable];
				let find = new RegExp(`${table}.\`${attr}\``, 'g');
				let replace = `${table}.[${index}]`;

				finalSql = finalSql.replace(find, replace);
			});
		}

		for (const schemaTable in this.data) {
			this.data[schemaTable].__mergedAttributes.forEach((attr, index) => {
				let find = new RegExp(`\`${attr}\``, 'g');
				let replace = `[${index}]`;

				finalSql = finalSql.replace(find, replace);
			});
		}
		return finalSql;
	}

	/**
	 * Builds out the final result JSON for a simple SQL query to return to the main search method without using alasql
	 * @returns {Promise<unknown[]>}
	 * @private
	 */
	async _simpleSQLQuery() {
		let aliasMap = this.statement.columns.reduce((acc, col) => {
			if (col.as_orig && col.as_orig != col.columnid_orig) {
				acc[col.columnid_orig] = col.as_orig;
			} else if (!acc[col.columnid_orig]) {
				acc[col.columnid_orig] = col.columnid_orig;
			}
			return acc;
		}, {});

		const fetchAttributesObjs = this.fetch_attributes.reduce((acc, attr) => {
			const schemaTable = `${attr.table.databaseid}_${attr.table.as ? attr.table.as : attr.table.tableid}`;
			if (!acc[schemaTable]) {
				acc[schemaTable] = {};
			}
			acc[schemaTable][aliasMap[attr.attribute]] = null;
			return acc;
		}, {});

		for (const attribute of this.fetch_attributes) {
			const schemaTable = `${attribute.table.databaseid}_${
				attribute.table.as ? attribute.table.as : attribute.table.tableid
			}`;

			let searchObject = {
				schema: attribute.table.databaseid,
				table: attribute.table.tableid,
				get_attributes: [attribute.attribute],
			};

			try {
				searchObject.attribute = attribute.attribute;
				searchObject.value = '*';
				const matchingData = await harperBridge.getDataByValue(searchObject);

				for (const [hashVal, record] of matchingData) {
					if (!this.data[schemaTable].__mergedData[hashVal]) {
						if (record[attribute.attribute] === undefined) record[attribute.attribute] = null;
						this.data[schemaTable].__mergedData[hashVal] = { ...fetchAttributesObjs[schemaTable] };
					}
					this.data[schemaTable].__mergedData[hashVal][aliasMap[attribute.attribute]] =
						record[attribute.attribute] ?? null;
				}
			} catch (err) {
				log.error('There was an error when processing this SQL operation.  Check your logs');
				log.error(err);
				throw new Error(SEARCH_ERROR_MSG);
			}
		}
		return Object.values(Object.values(this.data)[0].__mergedData);
	}
}

module.exports = SQLSearch;
