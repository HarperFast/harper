import { validateLicense } from '../validation/usageLicensing.ts';
import { ClientError } from '../utility/errors/hdbError.js';

interface InstallLicenseRequest {
	operation: 'install_usage_license';
	license: string;
}

export async function installUsageLicenseOp(req: InstallLicenseRequest): Promise<string> {
	const license = req.license;
	try {
		await installUsageLicense(license);
	} catch (cause) {
		const error = new ClientError('Failed to install usage license; ' + cause.message);
		error.cause = cause;
		throw error;
	}
	return 'Successfully installed usage license';
}

async function installUsageLicense(license: string): Promise<void> {
	const validatedLicense = validateLicense(license);
	const { id, ...licenseRecord } = validatedLicense;
	return databases.system.hdb_license.patch(id, licenseRecord);
}
