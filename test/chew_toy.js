
let file = '13005de7-6403-4b89-83de-35e9e9e0147d-1497021325380.hdb'
file = file.replace('.hdb', '');
winston.info(file);
let hash_tokens = file.split('-');
winston.info(hash_tokens);
hash_tokens.splice(hash_tokens.length -1,1);
winston.info(hash_tokens);