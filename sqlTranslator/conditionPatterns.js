const slash_regex =  /\//g;

module.exports = {
    createPatterns:createPatterns
};

function createPatterns(condition, table_schema, base_path){
    let table_path = `${base_path}${table_schema.schema}/${table_schema.name}/`;
    let pattern = {};
    let operation = Object.keys(condition)[0];
    let comparators = Object.values(condition)[0];
    let column = comparators[0].split('.');
    let attribute_name = column.length > 1 ? column[1] : column[0];
    pattern.table_path = table_path;
    let stripped_search_string;
    pattern.hash_path = `${table_path}__hdb_hash/${attribute_name}/`;
    pattern.folder_search_path = attribute_name === table_schema.hash_attribute ? pattern.hash_path : `${table_path + attribute_name}/`;

    let hdb_extension = attribute_name === table_schema.hash_attribute ? '\.hdb' : '';
    switch(operation){
        case '=':
            stripped_search_string = comparators[1] === '*' ? '*' :String(comparators[1]).replace(slash_regex, '').substring(0, 4000);
            pattern.folder_search = comparators[1] === '*' ? new RegExp('.*') : new RegExp(`^${RegExp.escape(stripped_search_string)+hdb_extension}$`);
            break;
        case 'in':
            let folder_searches = [];
            comparators[1].forEach((value)=>{
                let stripped_value = String(value).replace(slash_regex, '').substring(0, 4000);
                folder_searches.push(`^${RegExp.escape(stripped_value)+hdb_extension}$`);
            });
            pattern.folder_search = new RegExp(folder_searches.join('|'));
            break;
        case 'like':
            stripped_search_string = String(comparators[1]).replace(slash_regex, '').substring(0, 4000)
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