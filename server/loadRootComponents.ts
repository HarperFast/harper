import { isMainThread } from 'worker_threads';
import { getTables } from '../resources/databases.ts';
import { loadComponentDirectories, loadComponent } from '../components/componentLoader.ts';
import { resetResources } from '../resources/Resources.ts';
import * as configUtils from '../config/configUtils.ts';
import { dirname } from 'path';
import { loadCertificates } from '../security/keys.ts';
import { installApplications } from '../components/Application.ts';
import { errorForLog } from '../utility/logging/harper_logger.ts';

let loadedComponents = new Map();
/**
 * This is main entry point for loading the main set of global server modules that power Harper.
 * @returns {Promise<void>}
 */
async function loadRootComponents(isWorkerThread = false) {
	try {
		if (isMainThread && !process.env.HARPER_SAFE_MODE) await installApplications();
	} catch (error) {
		console.error(errorForLog(error));
	}

	let resources = resetResources();
	getTables();
	resources.isWorker = isWorkerThread;

	await loadCertificates();
	// the Harper root component
	await loadComponent(dirname(configUtils.getConfigFilePath()), resources, 'hdb', {
		isRoot: true,
		providedLoadedComponents: loadedComponents,
		autoReload: false,
	});
	if (!process.env.HARPER_SAFE_MODE) {
		// once the global plugins are loaded, we now load all the CF and run applications (and their components)
		await loadComponentDirectories(loadedComponents, resources);
	}
	let allReady = [];
	for (let [serverModule] of loadedComponents) {
		if (serverModule.ready) allReady.push(serverModule.ready());
	}
	if (allReady.length > 0) await Promise.all(allReady);
}

export { loadRootComponents };
