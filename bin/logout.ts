import { clearCredentials } from './cliCredentials.ts';

/**
 * Executes the logout command.
 */
export async function logout(target?: string): Promise<void> {
	clearCredentials(target);
}
