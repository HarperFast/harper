export { Resource } from './resources/Resource';
export { tables, databases } from './resources/databases';
import { tables as tables_source, databases } from './resources/databases';
export { findAndValidateUser as auth } from './security/user';
export { contentTypes } from './server/serverHelpers/contentTypes';
declare namespace harperdb {
	const tables: typeof tables_source;
}
