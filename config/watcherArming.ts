// See DESIGN.md, "`ready` means the watcher is armed". Platform is a parameter so a test on any
// host can pin the darwin value, rather than only observing its own.
export function armGraceMs(platform: string = process.platform): number {
	return platform === 'darwin' ? 20 : 0;
}

const ARM_GRACE_MS = armGraceMs();

/**
 * The gate a config watcher opens when its chokidar watcher is really watching: the initial scan
 * has finished *and* the platform's kernel-side warm-up has had its grace. Shared by
 * `RootConfigWatcher` and `OptionsWatcher` because both read the config synchronously, which is
 * what exposes the unarmed window in the first place.
 */
export class ArmGate {
	#armed: boolean = false;
	#timer: NodeJS.Timeout | undefined;
	#graceMs: number;

	// Taken as an argument, not read from the module constant, so the timer branch below is
	// reachable from a host whose own platform has no grace — unit tests are ubuntu-only.
	constructor(graceMs: number = ARM_GRACE_MS) {
		this.#graceMs = graceMs;
	}

	get armed(): boolean {
		return this.#armed;
	}

	// Synchronous where the platform needs no grace, so a watcher with no warm-up to wait out
	// keeps reading inside chokidar's own dispatch.
	arm(onArmed: () => void): void {
		if (this.#armed || this.#timer) return;
		if (!this.#graceMs) {
			this.#armed = true;
			onArmed();
			return;
		}
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#armed = true;
			onArmed();
		}, this.#graceMs);
	}

	// Drops a grace still counting down, for a watcher that is closing.
	cancel(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	// A replacement watcher has its own scan and its own unarmed window, so the gate arms again
	// with it: for a file that is *absent* when the replacement scans, chokidar reports `ready` and
	// nothing else, and the arming re-read is the only thing that would notice.
	reset(): void {
		this.cancel();
		this.#armed = false;
	}
}
