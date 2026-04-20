# Hanuman Thai Cafe — BaanBaan POS Appliance Identity

**System:** BaanBaan POS Relay (merchant-side POS and order relay)
**Site:** Hanuman Thai Cafe
**Runtime:** Bun on Raspberry Pi 4 (ARM64)
**OS:** Raspberry Pi OS (Debian Bookworm)
**Deploy path:** /home/baanbaan/baan-baan-merchant/v2
**Database:** SQLite at /home/baanbaan/baan-baan-merchant/v2/data/merchant.db (COSA has read-only access)
**Process supervisor:** systemd (service name: `baanbaan`)
**Appliance API:** HTTP on 127.0.0.1:3000 (localhost only; external access via Cloudflare Tunnel)
**External integrations:** Stripe (payments), SMTP (receipt email), Cloudflare Tunnel (public webhook ingress), CUPS (receipt printing)

## Network
**LAN IP:** 192.168.1.248
**SSH:** `baanbaan@192.168.1.248:22` (key: `/home/cosa/.ssh/id_ed25519_cosa`)
**Known open ports:** 22 (sshd), 3000 (baanbaan API, localhost only), 631 (CUPS, localhost only), 20241 (cloudflared mgmt, localhost only)

## Contacts
**Operator:** jdubray@gmail.com

## Known State
Last verified healthy: (COSA will update this field after each health check)
