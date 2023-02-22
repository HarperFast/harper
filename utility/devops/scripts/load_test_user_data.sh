#!/bin/bash
echo "##### Start of user_data.sh #####"

# Create and enable a 2GB swap file
dd if=/dev/zero of=/swapfile bs=128M count=16
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo "/swapfile swap swap defaults 0 0" | tee -a /etc/fstab

# Adjust the per-user open file limits
echo "ubuntu soft nofile 1000000" | tee -a /etc/security/limits.conf
echo "ubuntu hard nofile 1000000" | tee -a /etc/security/limits.conf

# Update installed packages
apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" upgrade --with-new-pkgs
apt-get update && apt-get -y upgrade

# Install git and k6
apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb https://dl.k6.io/deb stable main" | tee /etc/apt/sources.list.d/k6.list
apt-get update && apt-get install -y git k6