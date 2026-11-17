// One SafeModeBoot row per thread that executes this module: the suite's "component code ran" oracle.
const boot = databases.restore_safe_mode_other?.SafeModeBoot;
if (!boot) throw new Error('restore-safe-mode-access fixture: SafeModeBoot is not defined when resources.js loads');
// not awaited: the module is compiled as CommonJS-compatible source, which has no top-level await
boot.put({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, at: Date.now() });

export class SafeModeGuarded extends databases.restore_safe_mode.SafeModeLedger {
	allowRead(user) {
		return user?.username === 'auditor';
	}
}
