
module.exports = {
    parseConditions: parseConditions,
    parseWhereClause: parseWhereClause
};

function parseConditions(where_clause){
    let conditions = [];
    if(where_clause) {
        let left = where_clause[0];

        while (left.left.type === 'expression') {
            conditions.push(createConditionObject(left.operation, left.right));
            left = left.left;
        }

        conditions.push(createConditionObject(null, left));
    }

    conditions.reverse();

    return conditions.join(' ');
}

function createConditionObject(operation, condition){
    let condition_string = (operation ? operation + ' ' : '') + parseWhereClause(condition);
    return condition_string;
}

function parseWhereClause(where) {
    let condition = '';
    let operation = where.operation;

    switch(operation){
        case '=':
            condition = `${where.left.name} == `;
            if(where.right.value) {
                condition += where.right.value;
            } else {
                condition += where.right.name;
            }
            break;
        case '>':
        case '>=':
        case '<':
        case '<=':
            condition = `${where.left.name} ${where.operation} `;
            if(where.right.value) {
                condition += where.right.value;
            } else {
                condition += where.right.name;
            }
            break;
        case 'like':
            let value = where.right.value;
            if(typeof value === 'string'){
                value = `'${value}'`
            }
            condition = `like(${where.left.name}, ${value})`;
            break;
        case 'in':
            let compare_value = where.right.expression.filter((value_object)=>{
                let value = value_object.value;
                if(typeof value === 'string'){
                    value = `'${value}'`
                }
                compare_value.push(value);
            });
            condition = `in(${where.left.name}, ${compare_value})`;
            break;
        default:
            throw `unsupported operation ${operation}`;
            break;
    }

    return condition;
}