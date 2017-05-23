const sql_trans = require('../sqlTranslator/index');

//let sql = "INSERT INTO dev.person (id, first_name, dob) VALUES(1, 'Kyle', '09/24/1973'), (2, 'Zax', '03/12/1983')";

let sql = "select id, dog_name, license_type from dev.license where color IN ('CHOCOLATE', 'FAWN')";
console.time('sql');
sql_trans.evaluateSQL(sql, (err, data) => {
    console.timeEnd('sql');
    if(err){
        console.error(err.message);
    } else {
        console.log(data);
    }
});