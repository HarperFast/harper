const fs = require('node:fs');
const path = require('node:path');

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
    
    // Replace .ts with .js in any internal module path
    content = content.replace(/(['"]\.[^'"]+)\.ts(['"])/g, '$1.js$2');
    
    fs.writeFileSync(file, content, 'utf8');
}
console.log(`Converted .ts extensions to .js in ${tsFiles.length} files.`);
