const fs = require('node:fs');
const path = require('node:path');

const targets = [
    { name: 'envMgr', path: 'environmentManager.ts' },
    { name: 'env', path: 'environmentManager.ts' },
    { name: 'hdbUtils', path: 'common_utils.ts' },
    { name: 'commonUtils', path: 'common_utils.ts' },
    { name: 'hdbUtil', path: 'common_utils.ts' }
];

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
            if (!fullPath.includes('node_modules') && !fullPath.includes('.git') && !fullPath.includes('dist')) {
                results = results.concat(walk(fullPath));
            }
        } else {
            if (fullPath.endsWith('.ts')) {
                results.push(fullPath);
            }
        }
    });
    return results;
}

const tsFiles = walk('.');

for (const file of tsFiles) {
    let content = fs.readFileSync(file, 'utf8');
    let modified = false;
    
    for (const target of targets) {
        // Match: import target.name from '...target.path'
        const regex = new RegExp(`import ${target.name} from (['"]\\.[^'"]*${target.path}['"]);?`, 'g');
        if (content.match(regex)) {
            content = content.replace(regex, `import * as ${target.name} from $1;`);
            modified = true;
            console.log(`Converted ${target.name} to namespace import in ${file}`);
        }
    }
    
    if (modified) {
        fs.writeFileSync(file, content, 'utf8');
    }
}
