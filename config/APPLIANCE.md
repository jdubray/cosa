# Baanbaan Appliance — Identity

**System:** Baanbaan POS Relay
**Runtime:** Bun on Raspberry Pi 4 (ARM64)
**OS:** Raspberry Pi OS (Bookworm)
**Deploy path:** /home/baanbaan/app
**Database:** SQLite at /home/baanbaan/app/data/baanbaan.db
**Process supervisor:** systemd (service name: baanbaan)
**API:** HTTP on port 3000
**External POS:** Clover via REST API
**Cloudflare tunnel:** managed by cloudflared (service: cloudflared)

## Network
**LAN IP:** 192.168.1.10
**COSA Pi IP:** 192.168.1.11
**Router:** 192.168.1.1

## Contacts
**Operator:** owner@restaurant.com

## Known State
Last verified healthy: (COSA will update this field after each health check)
