// Child-process half of databaseAliasIdentity.test.js: closes two names of one store in the given
// order under a private root, so the parent can run it with the allocator perturbed and read a
// native fault as a non-zero exit. The mocha glob loads it too, hence the entry guard.
'use strict';
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

if (require.main === module) {
	const [rootPath, storageRoot, firstToClose, secondToClose] = process.argv.slice(2);
	const env = require('#src/utility/environment/environmentManager');
	const terms = require('#src/utility/hdbTerms');
	// A private root keeps this process off the parent's system database (RocksDB's lock is per
	// process); only the store under test is shared, at the path the parent chose.
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, rootPath);
	env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, join(rootPath, 'database'));
	env.setProperty(terms.CONFIG_PARAMS.DATABASES, { physicalalias: { path: storageRoot } });
	const { table, closeDatabase, resetDatabases } = require('#src/resources/databases');
	const { setMainIsWorker } = require('#js/server/threads/manageThreads');
	setMainIsWorker(true);
	mkdirSync(join(rootPath, 'database'), { recursive: true });
	mkdirSync(storageRoot, { recursive: true });

	(async () => {
		const Physical = table({
			database: 'physicalalias',
			table: 'CloseOrder',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'group', indexed: true },
			],
		});
		await Physical.put({ id: 'a', group: 'g' });
		closeDatabase('physicalalias');
		env.setProperty(terms.CONFIG_PARAMS.DATABASES, {
			configuredalias: { path: storageRoot },
			physicalalias: { path: storageRoot },
		});
		const databases = resetDatabases();
		// a read through each name is what binds its table handle to the environment slot the
		// other name's close then invalidates
		for (const name of [firstToClose, secondToClose]) {
			if ((await databases[name]?.CloseOrder.get('a'))?.group !== 'g')
				throw new Error(`${name} must read the shared store`);
		}
		closeDatabase(firstToClose);
		closeDatabase(secondToClose);
	})().then(
		() => process.exit(0),
		(error) => {
			console.error(error);
			process.exit(1);
		}
	);
}
