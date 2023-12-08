#!/bin/bash
echo "##### Start of user_data.sh #####"

# Create and enable a 2GB swap file
dd if=/dev/zero of=/swapfile bs=128M count=16
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo "/swapfile swap swap defaults 0 0" | tee -a /etc/fstab

cat <<EOF > /etc/security/limits.d/90-harperdb.conf
# Adjust the per-user open file limits
ubuntu - nofile 1000000

# Adjust the size of core dumps - 100MB and just making sure that core dumps are allowed
ubuntu - core unlimited
EOF

systemctl enable --now apport.service

useradd -m harperdbadmin
rm -rf /home/harperdbadmin/.ssh/*
echo "harperdbadmin ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/90-cloud-init-users