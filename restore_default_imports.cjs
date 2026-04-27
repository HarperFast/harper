const fs = require('node:fs');
const path = require('node:path');

// Modules that we KNOW have default exports
const hasDefaultExport = new Set([
    '../assignCmdEnvVariables.ts',
    '../../utility/assignCmdEnvVariables.ts',
    '../utility/assignCmdEnvVariables.ts',
    './assignCmdEnvVariables.ts',
    '../utility/environment/environmentManager.ts',
    '../../utility/environment/environmentManager.ts',
    './environmentManager.ts',
    '../common_utils.ts',
    '../../utility/common_utils.ts',
    './common_utils.ts'
]);

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
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        
        // Match `import * as identifier from './path.ts'`
        const match = line.match(/^([ \t]*)import \* as ([a-zA-Z0-9_$]+) from (['"](\.[^'"]+)['"]);?(.*)$/);
        if (match) {
            const indent = match[1];
            const identifier = match[2];
            const fullPathStr = match[3];
            const modulePath = match[4];
            const rest = match[5];
            
            if (hasDefaultExport.has(modulePath)) {
                lines[i] = `${indent}import ${identifier} from ${fullPathStr};${rest}`;
                modified = true;
                console.log(`Restored default import for ${identifier} in ${file}`);
            }
        }
    }
    
    if (modified) {
        fs.writeFileSync(file, lines.join('\n'), 'utf8');
    }
}
