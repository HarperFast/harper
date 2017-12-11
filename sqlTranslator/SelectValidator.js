"use strict";

const RecursiveIterator = require('recursive-iterator');

const validateTables = Symbol('validateTables'),
    validateTable = Symbol('validateTable'),
    getAllColumns = Symbol('getAllColumns'),
    validateAllColumns = Symbol('validateAllColumns'),
    findColumn = Symbol('findColumn'),
    validateOrderBy = Symbol('validateOrderBy'),
    validateSegment = Symbol('validateSegment'),
    validateColumn = Symbol('validateColumn'),
    setColumnsForTable = Symbol('setColumnsForTable'),
    checkColumnsForAsterisk = Symbol('checkColumnsForAsterisk');

class SelectValidator{
    constructor(statement){
        this.statement = statement;
        this.attributes = [];
    }

    validate(){
        if(!this.statement){
            return callback('invalid sql statement');
        }

        this[validateTables]();
        this[checkColumnsForAsterisk]();
        this[validateAllColumns]();
    }

    [validateTables](){
        if(!this.statement.from || this.statement.from.length === 0){
            throw `no from clause`;
        }

        this.statement.from.forEach((table)=>{
            this[validateTable](table);
        });

        if(this.statement.joins){
            this.statement.joins.forEach((join)=>{
                join.table.as = join.as;
                this[validateTable](join.table);
            });
        }
    }

    [validateTable](table){
        if(!table.databaseid){
            throw `schema not defined from table ${table.tableid}`;
        }

        if(!global.hdb_schema[table.databaseid] || !global.hdb_schema[table.databaseid][table.tableid]){
            throw `invalid table ${table.databaseid}.${table.tableid}`;
        }

        //let the_table = clone(table);
        let schema_table = global.hdb_schema[table.databaseid][table.tableid];

        schema_table.attributes.forEach((attribute)=>{
            attribute.table = table;
            this.attributes.push(attribute);
        });
    }



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

    [checkColumnsForAsterisk](){
        var iterator = new RecursiveIterator(this.statement.columns);

        for(let {node, path} of iterator) {
            if(node && node.columnid === '*'){
                this[setColumnsForTable](node.tableid);
            }
        }
    }

    [setColumnsForTable](table_name){
        let table_columns = [];

        this.attributes.forEach((attribute)=>{

            if(!table_name || (table_name && (attribute.table.tableid === table_name || attribute.table.as === table_name))){
                this.statement.columns.push({
                    columnid: attribute.attribute,
                    tableid: attribute.table.tableid
                });
            }
        });
    }

    [validateAllColumns](){
        let columns = this[validateSegment](this.statement.columns, null);
        this[validateSegment](this.statement.joins, null);
        this[validateSegment](this.statement.where, null);
        this[validateSegment](this.statement.order, columns);
    }

    [validateSegment](segment, columns){
        let cols = [];
        var iterator = new RecursiveIterator(segment);

        for(let {node, path} of iterator) {
            if(node && node.columnid && node.columnid !== '*'){
                this[validateColumn](node, columns);
                cols.push(node);
            }
        }

        return cols;
    }

    [validateColumn](column, columns){
        let found_columns = this[findColumn](column);

        if(found_columns.length === 0 && columns){
            found_columns = columns.filter((col)=>{
                return col.as === column.columnid;
            });
        }

        let column_name =  (column.tableid ? column.tableid + '.' : '') + column.columnid;

        if(found_columns.length === 0){
            throw `unknown column ${column_name}`;
        }

        if(found_columns.length > 1){
            throw `ambiguous column reference ${column_name}`;
        }
    }
}

module.exports = SelectValidator;