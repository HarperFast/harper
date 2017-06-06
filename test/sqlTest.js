const sql_trans = require('../sqlTranslator/index');

//let sql = "INSERT INTO dev.person (id, first_name, dob) VALUES(1, 'Kyle', '09/24/1973'), (2, 'Zax', '03/12/1983')";

let sql = {sql:"select b.name, b.section, l.id, l.dog_name from dev.breed as b inner join dev.license as l on b.id = l.breed order by breed.name asc, l.dog_name desc"};
console.time('sql');
sql_trans.evaluateSQL(sql, (err, data) => {
    console.timeEnd('sql');
    if(err){
        console.error(err.message);
    } else {
        console.log(data);
    }
});