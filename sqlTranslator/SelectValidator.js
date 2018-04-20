"use strict";

const RecursiveIterator = require('recursive-iterator'),
    alasql = require('alasql'),
    clone = require('clone');

//exclusion list for validation on group bys
const custom_aggregators = ['DISTINCT_ARRAY'];

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

/**
 * Validates the tables and attributes against the actual schema
 * Validates general SQL rules
 */
class SelectValidator{
    constructor(statement){
        this.statement = statement;
        this.attributes = [];
    }

    /**
     * entry point for validation
     * @returns {*}
     */
    validate(){
        if(!this.statement){
            return callback('invalid sql statement');
        }

        this[validateTables]();
        this[checkColumnsForAsterisk]();
        this[validateAllColumns]();
    }

    /**
     * if the statement has columns in it:
     * loops thru the from and join arrays of the AST and passes individual entries into validateTable
     */
    [validateTables](){
        if(this[hasColumns]()) {
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
    [hasColumns](){
        let has_columns = false;
        let iterator = new RecursiveIterator(this.statement);
        for(let {node, path} of iterator) {
            if(node && node.columnid){
                has_columns = true;
                break;
            }
        }
        return has_columns;
    }

    /**
     * Checks that the table exists in the schema, adds all of it's attributes to the class level collection this.attributes
     * @param table
     */
    [validateTable](table){
        if(!table.databaseid){
            throw `schema not defined for table ${table.tableid}`;
        }

        if(!global.hdb_schema[table.databaseid] || !global.hdb_schema[table.databaseid][table.tableid]){
            throw `invalid table ${table.databaseid}.${table.tableid}`;
        }

        //let the_table = clone(table);
        let schema_table = global.hdb_schema[table.databaseid][table.tableid];
/*TODO rather than putting every attribute in an array we will create a Map there will be a map element for every table and every table alias
 (this will create duplicate map elements) this will have downstream effects in comparison functions like findColumn*/
        schema_table.attributes.forEach((attribute)=>{
            let attribute_clone = clone(attribute);
            attribute_clone.table = table;
            this.attributes.push(attribute_clone);
        });
    }

    /**
     * validates the column against the schema
     * @param column
     * @returns {*[]}
     */
    [findColumn](column){
        //look to see if this attribute exists on one of the tables we are selecting from
        let found_columns = this.attributes.filter((attribute)=>{
            if(column.tableid){
                return (attribute.table.as === column.tableid || attribute.table.tableid === column.tableid) && attribute.attribute === column.columnid;
            } else {
                return attribute.attribute === column.columnid;
            }
        });

        return found_columns;
    }

    /**
     * detects * in the select, if found adds all columns to the select
     */
    [checkColumnsForAsterisk](){
        var iterator = new RecursiveIterator(this.statement.columns);

        for(let {node, path} of iterator) {
            //we check the path to make sure the '*' is not wrapped in some form of expression like count(*)
            if(node && node.columnid === '*' && path.indexOf('expression') < 0){
                this[setColumnsForTable](node.tableid);
            }
        }
    }

    /**
     * takes a table and adds all of it's columns to the select. if no table it adds every column from every tabl;e in the select
     * @param table_name
     */
    [setColumnsForTable](table_name){
        this.attributes.forEach((attribute)=>{

            if(!table_name || (table_name && (attribute.table.tableid === table_name || attribute.table.as === table_name))){
                this.statement.columns.push(new alasql.yy.Column({
                    columnid: attribute.attribute,
                    tableid: attribute.table.as ? attribute.table.as : attribute.table.tableid
                }));
            }
        });
    }

    /**
     * passes segments to ValidateSegment for validation
     */
    [validateAllColumns](){
        this[validateSegment](this.statement.columns, false);
        this[validateSegment](this.statement.joins, false);
        this[validateSegment](this.statement.where, false);
        this[validateGroupBy](this.statement.group);
        this[validateSegment](this.statement.order, true);
    }

    /**
     * iterates the attributes in a segment and validates them against the schema
     * @param segment
     * @param is_order_by
     * @returns {*}
     */
    [validateSegment](segment, is_order_by){
        if(!segment){
            return;
        }

        let iterator = new RecursiveIterator(segment);
        let attributes = [];
        for(let {node, path} of iterator) {
            if(node && node.columnid && node.columnid !== '*'){
                if(is_order_by) {
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
     * makes sure that the non-aggregate functionsa and columns from the select are represented in the group by and the columns match the schema
     * @param segment
     */
    [validateGroupBy](segment){
        if(!segment){
            return;
        }
        //check select for aggregates and non-aggregates, if it has both non-aggregates need to be in group by
        let select_columns = [];
//here we are pulling out all non-aggregate functions into an array for comaprison to the group by
        this.statement.columns.forEach((column)=>{

            //this keeps white listed custom functions from being validated
            if(column.funcid && custom_aggregators.indexOf(column.funcid.toUpperCase()) >= 0){
                return;
            }

            if(!column.aggregatorid && !column.columnid){
                //this is to make sure functions or any type ofevaluatory statement is being compared to the select.
                //i.e. "GROUP BY UPPER(name)" needs to have UPPER(name) in the select
                let column_clone = clone(column);
                delete column_clone.as;
                select_columns.push(column_clone);
            } else if(column.columnid){
                let found = this[findColumn](column)[0];
                if(found){
                    select_columns.push(found);
                }
            }
        });

//here we iterate the group by and compare to what is in the select and make sure they match appropriately
        this.statement.group.forEach((group_column)=>{
            let found_column = null;

            if(!group_column.columnid){
                //TODO can use for of to break out of the loop rather than this janky way
                select_columns.forEach((column, x) => {
                    if (column.toString() === group_column.toString()) {
                        found_column = column;
                        select_columns.splice(x, 1);
                        return;
                    }
                });
            } else {

                let found_group_column = this[findColumn](group_column);

                if (!found_group_column || found_group_column.length === 0) {
                    throw `unknown column '${group_column.toString()}' in group by`;
                }

                if (found_group_column.length > 1) {
                    throw `ambiguously defined column '${group_column.toString()}' in group by`;
                }

                //TODO can use for of to break out of the loop rather than this janky way
                select_columns.forEach((column, x) => {
                    if (column.attribute === found_group_column[0].attribute && column.table.tableid === found_group_column[0].table.tableid) {
                        found_column = column;
                        select_columns.splice(x, 1);
                        return;
                    }
                });
            }

            if(!found_column) {
                throw `group by column '${group_column.toString()}' must be in select`;
            }
        });

        if(select_columns.length > 0){
            throw `select column '${select_columns[0].attribute ? select_columns[0].attribute : select_columns[0].toString()}' must be in group by`;
        }
    }

    /**
     * Order BY specific validation
     *
     * @param column
     */
    [validateOrderBy](column){
        let found_columns = this.statement.columns.filter((col)=>{
            return col.as === column.columnid;
        });

        if(found_columns.length > 1){
            let column_name =  (column.tableid ? column.tableid + '.' : '') + column.columnid;
            throw `ambiguous column reference ${column_name} in order by`;
        } else if(found_columns.length === 0){
            this[validateColumn](column);
        }
    }

    /**
     * validates a column to the schema
     * @param column
     * @returns {*}
     */
    [validateColumn](column){
        let found_columns = this[findColumn](column);

        let column_name =  (column.tableid ? column.tableid + '.' : '') + column.columnid;

        if(found_columns.length === 0){
            throw `unknown column ${column_name}`;
        }

        if(found_columns.length > 1){
            throw `ambiguous column reference ${column_name}`;
        }

        return found_columns[0];
    }
}

module.exports = SelectValidator;