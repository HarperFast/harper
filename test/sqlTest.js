const sql_trans = require('../sqlTranslator/index');

//let sql = "INSERT INTO dev.person (id, first_name, dob) VALUES(1, 'Kyle', '09/24/1973'), (2, 'Zax', '03/12/1983')";

let sql = {sql:"select b.id as breed_id, b.name, b.section, l.id, l.breed, l.dog_name from dev.breed as b inner join dev.license as l on b.id = l.breed where b.id IN (1,2,3,4,5,6,7,8,9,10,11,12,13,14,15)"};
console.time('sql');
sql_trans.evaluateSQL(sql, (err, data) => {
    console.timeEnd('sql');
    if(err){
        console.error(err.message);
    } else {
        console.log(data);
    }
});