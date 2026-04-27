const fs = require('node:fs');
const files = [
    'components/operations.ts',
    'config/harperConfigEnvVars.ts',
    'config/configUtils.ts',
    'dataLayer/search.ts',
    'dataLayer/export.ts',
    'server/serverHelpers/serverUtilities.ts',
    'server/threads/socketRouter.ts',
    'server/threads/threadServer.ts',
    'server/threads/manageThreads.ts',
    'server/itc/serverHandlers.ts',
    'server/jobs/jobs.ts',
    'utility/operation_authorization.ts',
    'utility/mount_hdb.ts',
    'utility/errors/hdbError.ts'
];

for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    const topImports = new Set();
    const newLines = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.match(/^[ \t]+import /)) {
            // Check if it's an import statement and not dynamic import
            if (line.includes('from') || line.includes('\'ses\'') || line.includes('"ses"')) {
               const trimmed = line.trim();
               // Only move to top if we shouldn't use dynamic import
               // For now, move all to top to fix SyntaxError, we can fix circular deps if tests fail
               topImports.add(trimmed);
            } else {
               newLines.push(line);
            }
        } else {
            newLines.push(line);
        }
    }
    
    if (topImports.size > 0) {
        // Find the last top-level import to insert after, or just at the beginning
        let lastImportIdx = -1;
        for (let i = 0; i < newLines.length; i++) {
            if (newLines[i].startsWith('import ')) {
                lastImportIdx = i;
            }
        }
        
        const importsStr = Array.from(topImports).join('\n');
        if (lastImportIdx >= 0) {
            newLines.splice(lastImportIdx + 1, 0, importsStr);
        } else {
            newLines.unshift(importsStr);
        }
        
        fs.writeFileSync(file, newLines.join('\n'), 'utf8');
        console.log(`Fixed ${file}`);
    }
}
