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
    
    if (content.includes('import.meta.url')) {
        // We are building to CJS, so we can't use import.meta.url.
        // If we were building to ESM, we'd keep it.
        // Since we want CJS for tests, let's just use the global __dirname/__filename
        // which TypeScript will leave alone if we don't define them, 
        // OR we can define them in a way that doesn't use import.meta.
        
        // Remove the polyfills that use import.meta.url
        content = content.replace(/import \{ fileURLToPath \} from ['"]node:url['"];?\n?/g, '');
        content = content.replace(/import \{ dirname \} from ['"]node:path['"];?\n?/g, '');
        content = content.replace(/const __filename = fileURLToPath\(import\.meta\.url\);?\n?/g, '');
        content = content.replace(/const __dirname = dirname\(__filename\);?\n?/g, '');
        content = content.replace(/const __dirname = path\.dirname\(__filename\);?\n?/g, '');
        
        // Also remove any remaining import.meta.url usage
        // (This might need manual fixing if it's used elsewhere than __filename/__dirname)
        
        fs.writeFileSync(file, content, 'utf8');
        console.log(`Cleaned up import.meta in ${file}`);
    }
}
