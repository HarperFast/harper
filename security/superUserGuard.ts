import type { User } from './user.ts';

function isActiveSuperUser(user?: User): boolean {
	return Boolean(user?.active && user.role?.permission?.super_user);
}

/**
 * Whether an active super_user still exists once `simulate` is applied to every user; `simulate`
 * returns undefined for a user the change removes. True when none exists beforehand — there is no
 * last one to protect, and refusing would block the repair that restores one.
 */
export function activeSuperUserRemains(users: Iterable<User>, simulate: (user: User) => User | undefined): boolean {
	let present = false;
	let remains = false;
	for (const user of users) {
		if (isActiveSuperUser(user)) present = true;
		if (isActiveSuperUser(simulate(user))) remains = true;
	}
	return remains || !present;
}
