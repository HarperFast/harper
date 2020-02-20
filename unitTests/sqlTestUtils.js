"use strict";

const sql = require('../sqlTranslator/index');
const SelectValidator = require('../sqlTranslator/SelectValidator');

/**
 * Converts a sql statement into an AST object for an alasql operation
 * @param sql_statement
 * @returns {SelectValidator}
 */
function generateMockAST(sql_statement) {
    try {
        const test_ast = sql.convertSQLToAST(sql_statement);
        const validated_ast = new SelectValidator(test_ast.ast.statements[0]);
        validated_ast.validate();
        return validated_ast;
    } catch(e) {
        console.log(e);
    }
}

module.exports = {
    generateMockAST
};