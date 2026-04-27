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

let changedFiles = 0;

for (const file of tsFiles) {
    let content = fs.readFileSync(file, 'utf8');
    
    // Replace: import name from './local/path.ts';
    // With: import * as name from './local/path.ts';
    // Exclude imports that use curly braces or already use * as
    
    let modified = false;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        
        // Match `import identifier from './path'` or `import identifier from '../path'`
        const match = line.match(/^([ \t]*)import ([a-zA-Z0-9_$]+) from (['"]\.[^'"]+['"]);?(.*)$/);
        if (match) {
            const indent = match[1];
            const identifier = match[2];
            const modulePath = match[3];
            const rest = match[4];
            
            // Avoid renaming default imports if the module actually exports a default.
            // Since we know the codemod naively changed all requires to default imports,
            // changing them to `import * as` for local files is a very safe bet to fix TS1192.
            // We can skip 'chalk', 'minimist', etc because they don't start with '.'
            
            lines[i] = `${indent}import * as ${identifier} from ${modulePath};${rest}`;
            modified = true;
        }
    }
    
    if (modified) {
        fs.writeFileSync(file, lines.join('\n'), 'utf8');
        changedFiles++;
    }
}

console.log(`Fixed imports in ${changedFiles} files.`);
