# What run-estimate.sh and run-matrix.sh share once a run is provisioned: results copies, phases on the
# generator, and the generator ceiling check. Sourced after config.sh, with RUN_ID and RUN_DIR set; call
# session_init first. Every connection is plain ssh against the host keys pinned in the run directory
# (ycsb_ssh_init), so polls and copies keep working if the operator's gcloud session expires, and a session
# resumed in a fresh $HOME still verifies the hosts.

REMOTE_RESULTS="$YCSB_VM_REPO/benchmarks/ycsb-vs-pg/results"
# Seconds between a phase's status polls (60; lower only to exercise the scripts against fakes).
YCSB_PHASE_POLL_S="${YCSB_PHASE_POLL_S:-60}"

session_init() {
	ycsb_ssh_init "$RUN_DIR"
	YCSB_GCP_ZONE=$(cat "$RUN_DIR/zone")
	on_vm_retry generator "mkdir -p $REMOTE_RESULTS /opt/ycsb/logs"
}

# Fails, after three tries, if the results could not be copied: the generator holds the only copy.
# Copies both directories whole (into $RUN_DIR/results and $RUN_DIR/logs), so an empty one is not an error.
collect() {
	local address
	address=$(ycsb_vm_address generator) || return 1
	for try in 1 2 3; do
		timeout 600 scp -r "${YCSB_SSH[@]}" -o HostKeyAlias=vm-generator "$YCSB_VM_USER@$address:$REMOTE_RESULTS" \
			"$YCSB_VM_USER@$address:/opt/ycsb/logs" "$RUN_DIR/" && return 0
		echo "copying results from the generator failed (try $try)" >&2
		sleep 30
	done
	return 1
}

# on_vm, retried for 10 minutes: for commands that are safe to repeat, where one dropped connection must not
# end a run hours in.
on_vm_retry() {
	for try in $(seq 20); do
		on_vm "$@" && return 0
		echo "ssh to $1 failed (try $try of 20)" >&2
		sleep 30
	done
	return 1
}

# Copies the results one last time and tears the run down; the exit status says whether both worked.
session_finish() {
	local status=$1
	if ! collect; then
		echo "results since the last successful copy are lost: the generator is being deleted (cost guard)" >&2
		status=1
	fi
	"$YCSB_GCP_DIR/teardown.sh" "$RUN_ID" || {
		echo "teardown failed: run $YCSB_GCP_DIR/teardown.sh $RUN_ID once gcloud can reach $YCSB_GCP_PROJECT." \
			"GCE deletes the VMs $YCSB_MAX_RUN_DURATION after creation; the network, firewall rules and placement policy stay." >&2
		status=1
	}
	return "$status"
}

# A phase runs on the generator as a user service, so a dropped ssh session does not end it. It writes
# its exit status to a file when it ends, which this polls; the generator unreachable for 15 polls in a
# row ends the wait. Results are copied every 10 minutes and at the end. A phase that already has a
# status (a resumed session) is not started again, and one still running is waited on.
phase() {
	local name=$1 command=$2 status="" unreachable=0 polls=0 state
	echo "=== phase $name ($(date -u +%H:%M:%SZ))"
	# Idempotent, so a retry after a dropped connection cannot start the phase twice.
	state=$(on_vm_retry generator "if [ -s /opt/ycsb/logs/$name.status ]; then echo done; \
		elif systemctl --user is-active -q ycsb-$name; then echo running; else \
		systemctl --user reset-failed ycsb-$name 2>/dev/null; rm -f /opt/ycsb/logs/$name.status; \
		systemd-run --user --quiet --unit=ycsb-$name \
		--property=StandardOutput=append:/opt/ycsb/logs/$name.log --property=StandardError=append:/opt/ycsb/logs/$name.log \
		--working-directory=$YCSB_VM_REPO /bin/bash -c $(printf '%q' "$command; echo \$? > /opt/ycsb/logs/$name.status.tmp && mv /opt/ycsb/logs/$name.status.tmp /opt/ycsb/logs/$name.status") \
		&& echo started; fi") || return 1
	case "$state" in
	done) echo "phase $name already ended; reading its status" ;;
	running) echo "phase $name is still running; waiting for it" ;;
	started) ;;
	*)
		echo "phase $name could not be started: $state" >&2
		return 1
		;;
	esac
	while [ -z "$status" ]; do
		[ "$polls" = 0 ] && [ "$state" = done ] || sleep "$YCSB_PHASE_POLL_S"
		polls=$((polls + 1))
		# No status file and no running unit: systemd ended the phase before the wrapper could write one.
		if out=$(on_vm generator "s=/opt/ycsb/logs/$name.status; tail -n 2 /opt/ycsb/logs/$name.log >&2; if [ -s \$s ]; then cat \$s; \
			elif ! systemctl --user is-active -q ycsb-$name; then if [ -s \$s ]; then cat \$s; else echo ended-without-status; fi; fi"); then
			unreachable=0
			status=$out
		else
			unreachable=$((unreachable + 1))
			[ "$unreachable" -lt 15 ] || {
				echo "phase $name: the generator has been unreachable for 15 minutes" >&2
				return 1
			}
		fi
		[ $((polls % 10)) -ne 0 ] || collect || true
	done
	collect
	[ "$status" = 0 ] || {
		echo "phase $name exited $status (log in $RUN_DIR/logs/$name.log)" >&2
		return 1
	}
}

# Ceiling logs as <shards>:<log> pairs; prints the shard count the measured cells use and the ops/s it reached on C.
# A run with request errors does not count, and the second (half the shards) wins only if more than 5% faster. Busy
# cores do not decide: against a server faster than the driver, one shard per vCPU always reads as saturated, while
# on an SMT shape a shard per vCPU saturates the physical cores and still reads as two thirds busy. What bounds the
# cells is the ops/s the generator reached.
ceiling_choice() {
	local best="" best_ops=0 pair shards log ops
	for pair in "$@"; do
		shards=${pair%%:*} log=${pair#*:}
		ops=$(sed -n 's/.*CLIENT_CEILING workload=C .*ops_per_sec=\([0-9]*\).*/\1/p' "$log" 2>/dev/null | tail -1)
		[ -n "$ops" ] && ! grep -q 'workload=C .*errors=[1-9]' "$log" || continue
		if [ -z "$best" ] || [ "$ops" -gt $((best_ops * 105 / 100)) ]; then best=$shards best_ops=$ops; fi
	done
	[ -n "$best" ] && echo "$best $best_ops"
}

# The generator's own ceiling over the VPC: a fixed record served from the harper VM's 4 cores, driven at one shard
# per generator vCPU and at half that (ceiling_choice picks). The fixed-record server answers several times faster
# than any target, so the ceiling is the generator's; fails if it is under YCSB_MIN_CEILING_OPS. Prints the shard
# count, kept in $RUN_DIR/shards so a resumed session does not measure it again.
choose_shards() {
	local harper_ip gen_cpus best best_ops shards pairs=()
	if [ -s "$RUN_DIR/shards" ]; then
		cat "$RUN_DIR/shards"
		return 0
	fi
	harper_ip=$(jq -r '.roles.harper.address' "$RUN_DIR/hosts.json")
	on_vm_retry harper "systemctl --user reset-failed ycsb-ceiling-server 2>/dev/null; systemctl --user is-active -q ycsb-ceiling-server || \
		systemd-run --user --unit=ycsb-ceiling-server --working-directory=$YCSB_VM_REPO \
		/usr/local/bin/node benchmarks/ycsb-vs-pg/client-ceiling.mts --serve=4 --host=$harper_ip" >&2
	on_vm generator "for i in \$(seq 60); do curl -fsS -o /dev/null http://$harper_ip:9941/usertable/x && exit 0; sleep 1; done; exit 1" >&2
	gen_cpus=$(on_vm_retry generator nproc)
	for shards in "$gen_cpus" $((gen_cpus / 2)); do
		phase "ceiling-$shards" "node benchmarks/ycsb-vs-pg/client-ceiling.mts --base-url=http://$harper_ip:9941 \
			--concurrency=64 --shards=$shards" >&2 || true
		pairs+=("$shards:$RUN_DIR/logs/ceiling-$shards.log")
	done
	on_vm_retry harper 'systemctl --user stop ycsb-ceiling-server' >&2
	read -r best best_ops < <(ceiling_choice "${pairs[@]}") || true
	if [ -z "${best:-}" ] || [ "$best_ops" -lt "$YCSB_MIN_CEILING_OPS" ]; then
		echo "the generator reached ${best_ops:-no error-free} ops/s on C, under YCSB_MIN_CEILING_OPS=$YCSB_MIN_CEILING_OPS; raise YCSB_GEN_MACHINE_TYPE" >&2
		return 1
	fi
	echo "measured cells run with --shards=$best (client-ceiling: $best_ops ops/s on C)" >&2
	echo "$best" >"$RUN_DIR/shards"
	echo "$best"
}
