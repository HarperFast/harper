'use strict';

module.exports = processRows;

/**
 * Builds an array of datastores using passed attributes and a matching multi dimensional
 * array of row data
 * @param insert_obj
 * @param attributes
 * @param schema_table
 * @returns {{datastores: *, rows: *}}
 */
function processRows(insert_obj, attributes, schema_table) {
    let {schema, table, records} = insert_obj;
    let datastores = [];
    let rows = [];

    for (let i = 0; i < attributes.length; i++) {
        datastores.push(`${schema}/${table}/${attributes[i]}`);
    }

    for (let x = 0; x < records.length; x++) {
        let row_records = [];

        for (let y = 0; y < attributes.length; y++) {

            if (records[x].hasOwnProperty(attributes[y])) {
                row_records.push(records[x][attributes[y]]);
            } else {
                row_records.push(null);
            }
        }
        rows.push([records[x][schema_table.hash_attribute],row_records]);
    }

    let data_wrapper = {
        datastores,
        rows
    };

    return data_wrapper;
}
