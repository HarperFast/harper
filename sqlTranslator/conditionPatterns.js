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
    let pattern = {
        table_path: table_path,
        hash_path: `${table_path}__hdb_hash/${attribute_name}/`,
        blob_search: false
    };

    if(String(comparators[1]).length > 255 || String(comparators[1]).startsWith('%')){
        pattern.blob_search = true;
    }

    pattern.folder_search_path = attribute_name === table_schema.hash_attribute ? pattern.hash_path : `${table_path + attribute_name}/`;

    let hdb_extension = attribute_name === table_schema.hash_attribute ? '\.hdb' : '';

    switch(operation){
        case '=':
            stripped_search_string = comparators[1] === '*' ? '*' :String(comparators[1]).replace(slash_regex, '');
            pattern.folder_search = comparators[1] === '*' ? new RegExp('.*') : new RegExp(`^${RegExp.escape(stripped_search_string)+hdb_extension}$`);
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
            stripped_search_string = String(comparators[1]).replace(slash_regex, '')
                .replace(/[\*%]/g, '.*?');
            pattern.folder_search = new RegExp(`^${stripped_search_string+hdb_extension}$`);
            break;
        default:
            break;
    }

    return pattern;
}

RegExp.escape= function(s) {
    return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
};