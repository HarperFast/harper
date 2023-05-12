export { Resource } from './resources/Resource';
export { tables, databases } from './resources/tableLoader';
export { findAndValidateUser as auth } from './security/user';
import { findAndValidateUser as auth } from './security/user';
console.log(auth);
