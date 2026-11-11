#!/usr/bin/env bash
# Creates one benchmark run's VMs: a generator and target-shaped VMs for harper and the stack (and, with
# --topology=ab, redis and postgres for topology b), in a network of their own, one zone, one compact
# placement policy. Every VM is labeled with the run id and deleted by GCE after YCSB_MAX_RUN_DURATION.
# A failure part way tears down what was created. Writes runs/<run-id>/{hosts.json,manifest.json} and
# copies the hosts file and the run's ssh key to the generator.
#
#   YCSB_GCP_PROJECT=<project> gcp/provision.sh --run-id=ycsb-20261110-1 --topology=ab [--commit=<sha>]
#   gcp/provision.sh --dry-run ...     print the gcloud commands, call nothing
set -euo pipefail
. "$(dirname "$0")/config.sh"

RUN_ID=""
TOPOLOGY=ab
COMMIT=""
for arg in "$@"; do
	case "$arg" in
	--run-id=*) RUN_ID="${arg#*=}" ;;
	--topology=*) TOPOLOGY="${arg#*=}" ;;
	--commit=*) COMMIT="${arg#*=}" ;;
	--dry-run) export YCSB_DRY_RUN=1 ;;
	*)
		echo "unknown argument $arg" >&2
		exit 2
		;;
	esac
done
DRY="${YCSB_DRY_RUN:-0}"
: "${YCSB_GCP_PROJECT:?set YCSB_GCP_PROJECT}"
[ -n "$RUN_ID" ] || RUN_ID="ycsb-$(date -u +%Y%m%d-%H%M)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"
ycsb_check_run_id "$RUN_ID"
ROLES=$(ycsb_roles "$TOPOLOGY")
if [ -z "$COMMIT" ]; then
	COMMIT=$(git -C "$YCSB_GCP_DIR" rev-parse HEAD)
fi
if [ "$DRY" != 1 ] && ! git -C "$YCSB_GCP_DIR" branch -r --contains "$COMMIT" | grep -q .; then
	echo "commit $COMMIT is not on any pushed branch; the VMs fetch it from $YCSB_REPO_URL" >&2
	exit 1
fi
# SSH from the internet is opened to this address only; without it there is no rule to write.
BENCH_IP="${YCSB_BENCH_IP:-}"
if [ -z "$BENCH_IP" ] && [ "$DRY" != 1 ]; then BENCH_IP=$(curl -fsS --max-time 10 https://api.ipify.org || true); fi
if ! printf '%s' "$BENCH_IP" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
	echo "could not determine this host's public IPv4 address (set YCSB_BENCH_IP)" >&2
	exit 1
fi

P=(--project="$YCSB_GCP_PROJECT")
RUN_DIR="$YCSB_RUNS_DIR/$RUN_ID"
KEY="$RUN_DIR/id_ed25519"
NET="$RUN_ID-net"
SUBNET="$RUN_ID-subnet"
POLICY="$RUN_ID-compact"

if [ "$DRY" != 1 ]; then
	# The failure trap below deletes everything named for this run id, so it must be this invocation's alone.
	in_use=$(gcloud compute instances list "${P[@]}" --filter="labels.ycsb-run=$RUN_ID" --format='value(name)')
	if [ -n "$in_use" ] || gcloud compute networks describe "$NET" "${P[@]}" >/dev/null 2>&1; then
		echo "run id $RUN_ID is already in use in $YCSB_GCP_PROJECT; pick another" >&2
		exit 1
	fi
	mkdir -p "$RUN_DIR"
	chmod 700 "$RUN_DIR"
	[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "$RUN_ID" -f "$KEY"
	printf '%s:%s\n' "$YCSB_VM_USER" "$(cat "$KEY.pub")" >"$RUN_DIR/ssh-keys"
	# Anything created before a failure is the run's to delete.
	trap 'status=$?; if [ $status -ne 0 ]; then echo "provisioning failed ($status); tearing down $RUN_ID" >&2; "$YCSB_GCP_DIR/teardown.sh" "$RUN_ID" || true; fi' EXIT
fi

gc compute networks create "$NET" "${P[@]}" --subnet-mode=custom
gc compute networks subnets create "$SUBNET" "${P[@]}" --network="$NET" --region="$YCSB_GCP_REGION" --range="$YCSB_SUBNET_RANGE"
# The run's VMs reach each other on every port; from outside, only this host reaches SSH. No default
# allow-internal rule exists on a new network, so nothing else in the project reaches Redis or Postgres.
gc compute firewall-rules create "$RUN_ID-internal" "${P[@]}" --network="$NET" --direction=INGRESS \
	--allow=tcp,udp,icmp --source-ranges="$YCSB_SUBNET_RANGE"
gc compute firewall-rules create "$RUN_ID-ssh" "${P[@]}" --network="$NET" --direction=INGRESS \
	--allow=tcp:22 --source-ranges="$BENCH_IP/32"
gc compute resource-policies create group-placement "$POLICY" "${P[@]}" --region="$YCSB_GCP_REGION" --collocation=collocated

CREATE=(compute instances create)
if [ "$DRY" != 1 ] && ! gcloud compute instances create --help 2>/dev/null | grep -q -- '--performance-monitoring-unit'; then
	CREATE=(beta compute instances create)
fi
for role in $ROLES; do
	if [ "$role" = generator ]; then
		shape=(--machine-type="$YCSB_GEN_MACHINE_TYPE")
	else
		shape=(--machine-type="$YCSB_TARGET_MACHINE_TYPE" --threads-per-core=1 --performance-monitoring-unit=architectural)
	fi
	gc "${CREATE[@]}" "$RUN_ID-$role" "${P[@]}" --zone="$YCSB_GCP_ZONE" "${shape[@]}" \
		--network-interface="subnet=$SUBNET,nic-type=GVNIC" \
		--resource-policies="$POLICY" \
		--maintenance-policy=TERMINATE --provisioning-model=STANDARD \
		--no-service-account --no-scopes \
		--max-run-duration="$YCSB_MAX_RUN_DURATION" --instance-termination-action=DELETE \
		--labels="ycsb-bench=true,ycsb-run=$RUN_ID,ycsb-role=$role" \
		--image-family="$YCSB_IMAGE_FAMILY" --image-project="$YCSB_IMAGE_PROJECT" \
		--boot-disk-size="$YCSB_BOOT_DISK_SIZE" --boot-disk-type=hyperdisk-balanced \
		--metadata="ycsb-role=$role,ycsb-commit=$COMMIT,ycsb-repo=$YCSB_REPO_URL,ycsb-node-major=$YCSB_NODE_MAJOR,ycsb-k6-version=$YCSB_K6_VERSION,ycsb-k6-sha256=$YCSB_K6_SHA256,enable-oslogin=FALSE,enable-guest-attributes=TRUE" \
		--metadata-from-file="startup-script=$YCSB_GCP_DIR/startup.sh,ssh-keys=$RUN_DIR/ssh-keys"
done
if [ "$DRY" = 1 ]; then exit 0; fi

# The startup script reports through a guest attribute: ready, or failed:<line>:<status>.
deadline=$(($(date +%s) + 45 * 60))
for role in $ROLES; do
	while :; do
		state=$(gcloud compute instances get-guest-attributes "$RUN_ID-$role" "${P[@]}" --zone="$YCSB_GCP_ZONE" \
			--query-path=ycsb/state --format='value(value)' 2>/dev/null || true)
		case "$state" in
		ready) break ;;
		failed*)
			echo "$RUN_ID-$role: startup script $state" >&2
			exit 1
			;;
		esac
		if [ "$(date +%s)" -gt "$deadline" ]; then
			echo "$RUN_ID-$role: not ready after 45 minutes (state: ${state:-none})" >&2
			exit 1
		fi
		sleep 20
	done
	echo "$RUN_ID-$role ready"
done

ip_of() {
	gcloud compute instances describe "$RUN_ID-$1" "${P[@]}" --zone="$YCSB_GCP_ZONE" --format='value(networkInterfaces[0].networkIP)'
}
vm_json() {
	gcloud compute instances describe "$RUN_ID-$1" "${P[@]}" --zone="$YCSB_GCP_ZONE" --format=json |
		jq -c '{name, machineType: (.machineType | split("/") | last), cpuPlatform, internalIp: .networkInterfaces[0].networkIP, scheduling, labels}'
}
roles_json=""
vms_json=""
for role in $ROLES; do
	vms_json="$vms_json${vms_json:+,}\"$role\":$(vm_json "$role")"
	[ "$role" = generator ] && continue
	ip=$(ip_of "$role")
	roles_json="$roles_json${roles_json:+,}\"$role\":{\"ssh\":\"$YCSB_VM_USER@$ip\",\"address\":\"$ip\",\"dataDir\":\"/mnt/ycsb/data\",\"requireMount\":\"/mnt/ycsb\"}"
done
jq -n \
	--arg runId "$RUN_ID" --arg project "$YCSB_GCP_PROJECT" --arg zone "$YCSB_GCP_ZONE" --arg commit "$COMMIT" \
	--arg policy "$POLICY" --arg maxRun "$YCSB_MAX_RUN_DURATION" --arg image "$YCSB_IMAGE_PROJECT/$YCSB_IMAGE_FAMILY" \
	--arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson disk "$YCSB_DATA_DISK" --argjson vms "{$vms_json}" \
	'{runId: $runId, project: $project, zone: $zone, commit: $commit, createdAt: $created, image: $image,
	  placementPolicy: {name: $policy, collocation: "COLLOCATED"}, maxRunDuration: $maxRun,
	  terminationAction: "DELETE", maintenancePolicy: "TERMINATE", targetSmt: "off (threads-per-core=1)",
	  pmu: "architectural", dataDisk: $disk, bootDisk: "hyperdisk-balanced", vms: $vms,
	  turbo: "GCP VMs cannot turn turbo off: targets interleave within a session, 3 reps per cell, perf counts cycles"}' \
	>"$RUN_DIR/manifest.json"
jq -n --arg repo "$YCSB_VM_REPO" --argjson roles "{$roles_json}" --slurpfile meta "$RUN_DIR/manifest.json" \
	'{repoDir: $repo, roles: $roles, meta: $meta[0],
	  sshOptions: ["-i", "/home/ycsb/.ssh/ycsb_run", "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=/home/ycsb/.ssh/known_hosts_run"]}' \
	>"$RUN_DIR/hosts.json"

GEN_SSH=(compute ssh "$YCSB_VM_USER@$RUN_ID-generator" "${P[@]}" --zone="$YCSB_GCP_ZONE" --ssh-key-file="$KEY")
gcloud compute scp "${P[@]}" --zone="$YCSB_GCP_ZONE" --ssh-key-file="$KEY" "$KEY" "$YCSB_VM_USER@$RUN_ID-generator:.ssh/ycsb_run"
gcloud compute scp "${P[@]}" --zone="$YCSB_GCP_ZONE" --ssh-key-file="$KEY" "$RUN_DIR/hosts.json" "$YCSB_VM_USER@$RUN_ID-generator:/opt/ycsb/hosts.json"
gcloud "${GEN_SSH[@]}" --command='chmod 600 ~/.ssh/ycsb_run'
trap - EXIT
echo "provisioned $RUN_ID: $RUN_DIR/hosts.json"
