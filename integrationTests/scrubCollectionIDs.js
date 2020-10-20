const fs = require('fs');

const POSTMAN_COLLECTION_FILE_PATH = './hdb.json';

// This script deletes the `id` field in postman-collection.json that is changed without reason
// see https://github.com/postmanlabs/postman-app-support/issues/2906

const collection = JSON.parse(fs.readFileSync(POSTMAN_COLLECTION_FILE_PATH, 'utf8'));

for (const item of collection.item) {
    delve(item);
}

for (const event of collection.event) {
    delete event.script.id;
}

delete collection.info._postman_id;

for (const event of collection.variable) {
    delete event.id;
}

function delve(item){
    if(item) {
            if (Array.isArray(item.event)) {
                for (const event of item.event) {
                    delete event.script.id;
                }
            }

        if (Array.isArray(item.item)) {
            for (const sub of item.item) {
                delve(sub);
            }

        }
    }
}

fs.writeFileSync(POSTMAN_COLLECTION_FILE_PATH, JSON.stringify(collection, null, '\t'));

console.log('done');