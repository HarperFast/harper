import { isMainThread } from 'worker_threads';
import { getTables } from '../resources/databases.js';
import { loadComponentDirectories, loadComponent } from '../components/componentLoader.js';
import { resetResources } from '../resources/Resources.js';
import * as configUtils from '../config/configUtils.js';
import { dirname } from 'path';
import { loadCertificates } from '../security/keys.js';
import { installApplications } from '../components/Application.js';

let loadedComponents = new Map();
/**
 * This is main entry point for loading the main set of global server modules that power Harper.
 * @returns {Promise<void>}
 */
export async function loadRootComponents(isWorkerThread = false): Promise<void> {
	try {
		if (isMainThread && !process.env.HARPER_SAFE_MODE) await installApplications();
	} catch (error) {
		console.error(error);
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
	let allReady: Promise<any>[] = [];
	for (let [serverModule] of loadedComponents) {
		if (serverModule.ready) allReady.push(serverModule.ready());
	}
	if (allReady.length > 0) await Promise.all(allReady);
}
