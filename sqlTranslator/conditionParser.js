
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

        conditions.push(createConditionObject('and', left));
    }

    conditions.reverse();

    return conditions;
}

function createConditionObject(operation, condition){
    //operation = '||' ? 'like' : operation;
    let condition_object = {};
    if(operation) {
        condition_object[operation] = parseWhereClause(condition);
    } else{
        condition_object = parseWhereClause(condition);
    }
    return condition_object;
}

function parseWhereClause(where) {
    //we had replaced LIKE with || before generating the AST, now we need to switch it back.
    let operation = where.operation;
    let condition_object = {};
    condition_object[operation] = [];
    condition_object[operation].push(`${where.left.name}`);

    switch(operation){
        case '=':
        case '>':
        case '>=':
        case '<':
        case '<=':
        case 'like':
            if(where.right.value) {
                condition_object[operation].push(where.right.value);
            } else {
                condition_object[operation].push(`${where.right.name}`);
            }
            break;
        case 'in':
            let compare_value = [];
            where.right.expression.forEach((value_object)=>{
                compare_value.push(value_object.value);
            });
            condition_object[operation].push(compare_value);
            break;
        default:
            break;
    }

    return condition_object;
}