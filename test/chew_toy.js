
let file = '13005de7-6403-4b89-83de-35e9e9e0147d-1497021325380.hdb'
file = file.replace('.hdb', '');
console.log(file);
let hash_tokens = file.split('-');
console.log(hash_tokens);
hash_tokens.splice(hash_tokens.length -1,1);
console.log(hash_tokens);