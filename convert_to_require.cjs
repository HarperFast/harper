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
    
    if (content.includes('await import(')) {
        // Replace (await import('foo')) with require('foo')
        // We need to handle various forms:
        // 1. (await import('...')).default
        // 2. (await import('...')).something
        // 3. await import('...')
        
        // Let's use a relatively safe regex for the most common patterns we introduced
        content = content.replace(/\(await import\((['"][^'"]+['"])\)\)\.default/g, "require($1)");
        content = content.replace(/\(await import\((['"][^'"]+['"])\)\)/g, "require($1)");
        content = content.replace(/await import\((['"][^'"]+['"])\)/g, "require($1)");
        
        fs.writeFileSync(file, content, 'utf8');
        console.log(`Converted dynamic imports to require in ${file}`);
    }
}
