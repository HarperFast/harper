"use strict";

module.exports = heGenerateDataStoreName;

function heGenerateDataStoreName(schema, table, attr) {
    return `${schema}/${table}/${attr}`;
}