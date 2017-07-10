const sql_trans = require('../sqlTranslator/index');

//let sql = {sql:"INSERT INTO dev.person (id, dog_name) VALUES(1, 'Penny')"};

let sql = {sql:"SELECT d.id, d.dog_name as dname, d.owner_name, b.name, b.section FROM dev.dog AS d INNER JOIN dev.breed AS b ON d.breed_id = b.id WHERE d.owner_name IN ('Kyle', 'Zach', 'Stephen') AND b.section = 'Mutt' ORDER BY dname"};
//let sql = {sql:"update dev.breed set section = 'stuff' where id = 2"};
//let sql = {sql:"DELETE FROM dev.dog WHERE adorable = 'true'"};
console.time('sql');
sql_trans.evaluateSQL(sql, (err, data) => {
    console.timeEnd('sql');
    if(err){
        winston.error(err);
    } else {
        winston.info(data);
        winston.info(data.length);
    }
});