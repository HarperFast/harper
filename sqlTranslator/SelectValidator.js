"use strict";

const _ = require('lodash'),
    traverse = require('traverse'),
    clone = require('clone');

const validateTables = Symbol('validateTables'),
    validateTable = Symbol('validateTable'),
    getAllColumns = Symbol('getAllColumns'),
    validateAllColumns = Symbol('validateAllColumns'),
    findColumn = Symbol('findColumn');

class SelectValidator{
    constructor(statement){
        this.statement = statement;
        this.tables = [];
    }

    validate(){
        if(!this.statement){
            return callback('invalid sql statement');
        }

        this[validateTables]();
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

        let the_table = clone(table);
        let schema_table = global.hdb_schema[table.databaseid][table.tableid];
        if(!schema_table.attributes || schema_table.attributes.length === 0){
            the_table.attributes = [schema_table.hash_attribute];
        } else {
            the_table.attributes = schema_table.attributes;
        }


        this.tables.push(the_table);
    }

    [validateAllColumns](){
        let columns = this[getAllColumns]();

        columns.forEach((column)=>{
            this[findColumn](column);
        });
    }

    [findColumn](column){
        //look to see if this attribute exists on one of the tables we are selecting from
        let found_tables = this.tables.filter((table)=>{
            if(column.tableid){
                return (table.as === column.tableid || table.tableid === column.tableid) && table.attributes.indexOf(column.columnid) >= 0;
            } else {
                return table.attributes.indexOf(column.columnid) >= 0;
            }
        });
        let column_name =  (column.tableid ? column.tableid + '.' : '') + column.columnid;

        if(found_tables.length === 0){
            throw `unknown column ${column_name}`;
        }

        if(found_tables.length > 1){
            throw `ambiguous column ${column_name}`;
        }
    }

    [getAllColumns](){
        let columns = [];

        traverse(this.statement).forEach((node)=>{
            if(node && node.columnid){
                columns.push(node);
            }
        });

        return columns;
    }
}

module.exports = SelectValidator;