#!/usr/bin/env bash
# GCE startup script for a ycsb-vs-pg VM (provision.sh sets it). Runs as root at boot. Mounts the
# data disk at /mnt/ycsb, installs Docker, Node (CI's major), perf and git, prepares user ycsb (docker, user
# systemd with the memory controller delegated, linger), checks out the harness at the run's commit and
# builds what the VM's role runs. Reports ready or failed:<line>:<status> as guest attribute ycsb/state,
# which provision.sh polls.
set -euo pipefail
MD=http://metadata.google.internal/computeMetadata/v1/instance
attr() { curl -fsS -H 'Metadata-Flavor: Google' "$MD/attributes/$1"; }
report() { curl -fsS -X PUT --data "$1" -H 'Metadata-Flavor: Google' "$MD/guest-attributes/ycsb/state" || true; }
trap 'report "failed:$LINENO:$?"' ERR

DEV=/dev/disk/by-id/$(attr ycsb-data-device)
# A later boot (a guest reboot keeps the data disk): mount the existing filesystem again, never reformat it.
if [ -f /var/lib/ycsb/ready ]; then
	if [ -e "$DEV" ] && ! mountpoint -q /mnt/ycsb; then mount -o noatime "$DEV" /mnt/ycsb; fi
	report ready
	exit 0
fi
report installing
ROLE=$(attr ycsb-role)
COMMIT=$(attr ycsb-commit)
REPO=$(attr ycsb-repo)
NODE_MAJOR=$(attr ycsb-node-major)
export DEBIAN_FRONTEND=noninteractive

APT_OPTS=(-o Acquire::Languages=none -o Acquire::http::Timeout=30 -o Acquire::Retries=3)
# The zone's GCE mirror can crawl (one 15 MB index took 15 minutes). Each download is bounded and, past the
# bound, retried from the main archive; dpkg runs only once every package is local, so no kill lands mid-install.
fetch() {
	timeout 300 apt-get "${APT_OPTS[@]}" "$@" && return
	for sources in /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list; do
		if [ -f "$sources" ]; then sed -i 's#http://[a-z0-9-]*\.gce\.archive\.ubuntu\.com/ubuntu#http://archive.ubuntu.com/ubuntu#' "$sources"; fi
	done
	apt-get "${APT_OPTS[@]}" update -q
	[ "$1" = update ] || apt-get "${APT_OPTS[@]}" "$@"
}
# libatomic1: the Node 26 binary links it, and the image does not ship it.
PACKAGES=(git curl jq ca-certificates xz-utils util-linux libatomic1 linux-tools-common "linux-tools-$(uname -r)")
if [ "$ROLE" != generator ]; then PACKAGES+=(docker.io docker-compose-v2); fi
fetch update -q
fetch install -yq --download-only "${PACKAGES[@]}"
apt-get "${APT_OPTS[@]}" install -yq "${PACKAGES[@]}"
if [ "$ROLE" != generator ]; then
	[ -e "$DEV" ] || {
		echo "no data disk at $DEV" >&2
		false
	}
	# Eager inode and journal init: no background initialization writes while a run measures the disk.
	mkfs.ext4 -q -F -E lazy_itable_init=0,lazy_journal_init=0 "$DEV"
	mkdir -p /mnt/ycsb
	mount -o noatime "$DEV" /mnt/ycsb
fi

VERSION=$(curl -fsS https://nodejs.org/dist/index.json | jq -r --arg m "v$NODE_MAJOR." '[.[] | select(.version | startswith($m))][0].version')
curl -fsSL "https://nodejs.org/dist/$VERSION/node-$VERSION-linux-x64.tar.xz" | tar -xJ -C /opt
ln -sfn "/opt/node-$VERSION-linux-x64" /opt/node
for bin in node npm npx; do ln -sf "/opt/node/bin/$bin" "/usr/local/bin/$bin"; done

id ycsb >/dev/null 2>&1 || useradd -m -s /bin/bash ycsb
if [ "$ROLE" != generator ]; then usermod -aG docker ycsb; fi
# systemd-run --user scopes need the memory controller in the user manager; the harness checks every cap.
mkdir -p /etc/systemd/system/user@.service.d
printf '[Service]\nDelegate=cpu cpuset io memory pids\n' >/etc/systemd/system/user@.service.d/delegate.conf
systemctl daemon-reload
loginctl enable-linger ycsb
printf 'kernel.perf_event_paranoid = -1\nkernel.kptr_restrict = 0\n' >/etc/sysctl.d/90-ycsb-perf.conf
sysctl -q --system

mkdir -p /opt/ycsb/logs
if [ "$ROLE" != generator ]; then
	mkdir -p /mnt/ycsb/data
	chown -R ycsb:ycsb /mnt/ycsb
fi
chown -R ycsb:ycsb /opt/ycsb
sudo -u ycsb -H bash -c "set -e; git init -q /opt/ycsb/harper; cd /opt/ycsb/harper; git remote add origin '$REPO'; git fetch -q --depth 1 origin '$COMMIT'; git checkout -q FETCH_HEAD"
cd /opt/ycsb/harper
case "$ROLE" in
harper)
	sudo -u ycsb -H bash -c 'set -e; npm ci --no-audit --no-fund; npm run build'
	# du and rm of snapshots run as root in a throwaway container (pgStack.mts dataDirBytes).
	docker pull -q alpine:latest
	;;
stack)
	sudo -u ycsb -H bash -c 'set -e; npm ci --no-audit --no-fund --prefix benchmarks/ycsb-vs-pg/pg-app'
	for image in postgres:17-alpine redis:7-alpine alpine:latest; do docker pull -q "$image"; done
	;;
redis | postgres) for image in postgres:17-alpine redis:7-alpine alpine:latest; do docker pull -q "$image"; done ;;
generator) ;;
esac

mkdir -p /var/lib/ycsb
date -u >/var/lib/ycsb/ready
report ready
