const fill = require('fill-range'),
    daterange = require('daterange');
const h_utils = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const { MAX_CHARACTER_SIZE } = hdb_terms.INSERT_MODULE_ENUM;

const slash_regex =  /\//g;

module.exports = {
    createPatterns:createPatterns
};

function createPatterns(condition, table_schema, base_path){
    let table_path = `${base_path}${table_schema.schema}/${table_schema.name}/`;

    let operation = Object.keys(condition)[0];
    let comparators = Object.values(condition)[0];
    let column = comparators[0].split('.');
    let attribute_name = column.length > 1 ? column[1] : column[0];

    let stripped_search_string;
    let stripped_folder_string;
    let pattern = {
        table_path: table_path,
        hash_path: `${table_path}__hdb_hash/${attribute_name}/`,
        blob_search: false,
        blob_regex: null
    };

    const starts_with_wildcard = String(comparators[1]).startsWith('%') || String(comparators[1]).startsWith('*');
    const ends_with_wildcard = String(comparators[1]).endsWith('%') || String(comparators[1]).endsWith('*');

    if(Buffer.byteLength(String(comparators[1])) > MAX_CHARACTER_SIZE || starts_with_wildcard || ends_with_wildcard) {
        pattern.blob_search = true;
    }

    //if search attribute is hash_attr, search by primary index (i.e. '__hdb_hash' dir) - if not, search on secondary index (i.e. attr value directory)
    pattern.folder_search_path = attribute_name === table_schema.hash_attribute ? pattern.hash_path : `${table_path + attribute_name}/`;

    let hdb_extension = attribute_name === table_schema.hash_attribute ? '\.hdb' : '';

    switch(operation){
        case '=':
            stripped_search_string = (comparators[1] === '*' || comparators[1] === '%') ? '*' : RegExp.escape(h_utils.escapeRawValue(comparators[1]));
            stripped_folder_string = (comparators[1] === '*' || comparators[1] === '%') ? new RegExp('.*') : new RegExp(`^${stripped_search_string+hdb_extension}$`);
            pattern.folder_search = stripped_folder_string;
            if (pattern.blob_search) {
                pattern.blob_regex = (comparators[1] === '*' || comparators[1] === '%') ? new RegExp('.*') : new RegExp(`^${stripped_search_string}$`);
            }
            break;
        case '>':
            pattern.folder_search = new RegExp(fill(Number(comparators[1]) + 1, Number.MAX_SAFE_INTEGER, {toRegex:true}));
            break;
        case '>=':
            pattern.folder_search = new RegExp(fill(Number(comparators[1]), Number.MAX_SAFE_INTEGER, {toRegex:true}));
            break;
        case '<':
            pattern.folder_search = new RegExp(fill(Number(comparators[1]) - 1, Number.MIN_SAFE_INTEGER, -1, {toRegex:true}));
            break;
        case '<=':
            pattern.folder_search = new RegExp(fill(Number(comparators[1]), Number.MIN_SAFE_INTEGER, -1, {toRegex:true}));
            break;
        case 'between':
            break;
        case 'in':
            let folder_searches = [];
            comparators[1].forEach((value)=>{
                let stripped_value = String(value).replace(slash_regex, '');
                folder_searches.push(`^${RegExp.escape(stripped_value)+hdb_extension}$`);
            });
            pattern.folder_search = new RegExp(folder_searches.join('|'));
            break;
        case 'like':
            // stripped_search_string = h_utils.escapeRawValue(String(comparators[1]))
            //     .replace(/[\*%]/g, '.*?');
            // pattern.folder_search = new RegExp(`^${stripped_search_string+hdb_extension}$`);
            // stripped_search_string = h_utils.escapeRawValue(comparators[1]);
            // stripped_folder_string = new RegExp(`${stripped_search_string.replace(/[\*%]/g, '.*?')}`);
            // pattern.folder_search = stripped_folder_string;
            pattern.folder_search = buildLikeRegex(comparators[1], 'folder');
            if (pattern.blob_search) {
                // const blob_string = String(comparators[1]).replace(/[\*%]/g, '.*?');
                // pattern.blob_regex = new RegExp(`${blob_string}`);
                pattern.blob_regex = buildLikeRegex(comparators[1], 'blob');
            }
            break;
        default:
            break;
    }

    return pattern;
}

RegExp.escape= function(s) {
    return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
};

function buildLikeRegex(search_string, regex_type) {
    const starts_w_wildcard = search_string.startsWith('*') || search_string.startsWith('%');
    const ends_w_wildcard = search_string.length > 1 && (search_string.endsWith('*') || search_string.endsWith('%'));
    let split_string = search_string.split('');
    if (starts_w_wildcard) {
        split_string.shift();
    }
    if (ends_w_wildcard) {
        split_string.pop();
    }

    let final_search_string;
    if (regex_type === 'folder') {
        final_search_string = RegExp.escape(h_utils.escapeRawValue(split_string.join('')));
    } else {
        final_search_string = RegExp.escape(split_string.join(''));
    }

    if (starts_w_wildcard) {
        final_search_string = '.*?' + final_search_string;
    } else {
        final_search_string = '^' + final_search_string;
    }

    if (ends_w_wildcard) {
        final_search_string = final_search_string + '.*?';
    } else {
        final_search_string = final_search_string + '$';
    }

    return new RegExp(final_search_string);

}