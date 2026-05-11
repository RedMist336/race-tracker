#!/bin/bash
set -euo pipefail
cp /home/odroid/20-dhcp.network /etc/systemd/network/20-dhcp.network
chown root:root /etc/systemd/network/20-dhcp.network
chmod 644 /etc/systemd/network/20-dhcp.network
systemctl restart systemd-networkd
sleep 2
ip -4 addr show eth0
ip route
