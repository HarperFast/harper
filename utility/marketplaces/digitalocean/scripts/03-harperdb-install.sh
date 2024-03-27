#!/usr/bin/env bash
set -euo pipefail

hdb_system_user="${HDB_SYSTEM_USER:-harperdb}"
harperdb_version="${HARPERDB_VERSION:-latest}"
node_version="v${NODE_VERSION:-lts/iron}"
hdb_root="${HDB_ROOT:-/opt/hdb}"
nvm_version="${NVM_VERSION:-v0.39.7}"

# digital Ocean does not provide a non-root user. Creating a user if it doesn't exist
getent passwd "${hdb_system_user}" > /dev/null 2>&1 || adduser "${hdb_system_user}" --gecos "" --disabled-password

# Create directory to store the database
mkdir -p "${hdb_root}"

# Append unattended-upgrades config
printf 'Unattended-Upgrade::Remove-Unused-Dependencies "true";\n' > /etc/apt/apt.conf.d/52unattended-upgrades-local

# Create and enable a 2GB swap file
if [ ! -f "/swapfile" ]; then
  dd if=/dev/zero of=/swapfile bs=128M count=16
  chmod 600 /swapfile
  mkswap /swapfile
fi

grep -Fxq "/swapfile swap swap defaults 0 0" /etc/fstab || echo "/swapfile swap swap defaults 0 0" | tee -a /etc/fstab
swapon -a

# create a volume if we don't have it
if [ ! -e "/dev/hdb_vg/hdb_lv" ]; then
  # If we have unmounted disks to use, we will use them
  # Create array of free disks
  declare -a free_disks
  mapfile -t free_disks < <(lsblk -P -I 8 | grep 'MOUNTPOINTS=""' | grep -o 'sd.')

  # Get quantity of free disks
  free_disks_qty=${#free_disks[@]}
  if [ "${free_disks_qty}" -gt 0 ]; then
    # Construct pvcreate command
    cmd_string=""
    for i in "${free_disks[@]}"
    do
      # first, unmount the volume
      umount $i > /dev/null 2>&1 || true
      cmd_string="${cmd_string} /dev/$i"
    done

    # Initialize disks for use by LVM
    pvcreate_cmd="pvcreate -f ${cmd_string}"
    ${pvcreate_cmd}

    # Create volume group
    vgcreate_cmd="vgcreate hdb_vg ${cmd_string}"
    ${vgcreate_cmd}

    # Create logical volume
    lvcreate -n hdb_lv -i "${free_disks_qty}" -l 100%FREE hdb_vg

    # Create filesystem on logical volume
    mkfs.ext4 -L hdb_data /dev/hdb_vg/hdb_lv
  fi
fi

# Create fstab entry to mount filesystem on boot
if [ -e "/dev/hdb_vg/hdb_lv" ]; then
  grep -Fxq "LABEL=hdb_data ${hdb_root} ext4 defaults,noatime 0 1" /etc/fstab || \
    echo "LABEL=hdb_data ${hdb_root} ext4 defaults,noatime 0 1" | tee -a /etc/fstab

  # Mount the file system
  mount "${hdb_root}"
fi

# set permissions on database directory
chown -R "${hdb_system_user}":"${hdb_system_user}" "${hdb_root}"
chmod 775 "${hdb_root}"

# Adjust the per-user open file limits
grep -Fxq "${hdb_system_user} soft nofile 500000" /etc/security/limits.conf || echo "${hdb_system_user} soft nofile 500000" | sudo tee -a /etc/security/limits.conf
grep -Fxq "${hdb_system_user} hard nofile 1000000" /etc/security/limits.conf || echo "${hdb_system_user} hard nofile 1000000" | sudo tee -a /etc/security/limits.conf

# Install nvm
if ! command -v nvm ; then
  curl -sL -o- "https://raw.githubusercontent.com/nvm-sh/nvm/${nvm_version}/install.sh" | su -l "${hdb_system_user}" -c bash
fi

# Install Node
su -l "${hdb_system_user}" -c "source /home/${hdb_system_user}/.nvm/nvm.sh; nvm install \"${node_version}\""

# Install HarperDB
su -l "${hdb_system_user}" -c "PATH=\"/home/${hdb_system_user}/.nvm/versions/node/${node_version}/bin:${PATH}\"; npm install -g harperdb@${harperdb_version}"

# create systemd file
cat <<EOF > /etc/systemd/system/harperdb.service
[Unit]
Description=HarperDB

[Service]
Type=simple
Restart=always
User=${hdb_system_user}
Group=${hdb_system_user}
WorkingDirectory=/home/${hdb_system_user}
Environment=NODE_ENV=production
Environment=ROOTPATH=${hdb_root}
ExecStart=/bin/bash -c 'PATH="/home/${hdb_system_user}/.nvm/versions/node/${node_version}/bin:\$PATH"; harperdb'

[Install]
WantedBy=multi-user.target
EOF