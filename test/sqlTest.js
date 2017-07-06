const sql_trans = require('../sqlTranslator/index');

//let sql = {sql:"INSERT INTO dev.person (id, dog_name) VALUES(1, 'Penny')"};

//let sql = {sql:"select name, section from dev.breed where id = 1"};
let sql = {sql:"SELECT d.id, d.dog_name, d.owner_name, b.name, b.section FROM dev.dog as d INNER JOIN dev.breed AS b ON d.breed_id = b.id WHERE d.owner_name IN ('Kyle', 'Zach', 'Stephen') ORDER BY d.dog_name"};
//let sql = {sql:"update dev.breed set section = 'stuff' where id = 2"};
//let sql = {sql:"DELETE FROM dev.dog WHERE adorable = 'true'"};
console.time('sql');
sql_trans.evaluateSQL(sql, (err, data) => {
    console.timeEnd('sql');
    if(err){
        console.error(err);
    } else {
        console.log(data);
        console.log(data.length);
    }
});