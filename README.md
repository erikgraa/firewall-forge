<div align="center">

<img src="public/icon.svg" alt="Firewall Forge icon" width="120" />

# 🔥 Firewall Forge

**Define your firewall rules once — forge config for every platform.** 🛡️

A static TypeScript + React app. Everything runs in your browser, nothing is sent anywhere. 🔒

🌐 [firewall-forge.graa.dev](https://firewall-forge.graa.dev)

</div>

## 🎯 Targets

| | Target | Output |
| --- | --- | --- |
| ☁️ | NSX DFW | Terraform (`vmware/nsxt`) |
| 🪟 | Windows Server SDN ACL | PowerShell (Network Controller cmdlets) |
| 🔷 | Azure Local NSG | `az stack-hci-vm network nsg` commands, or Bicep (`Microsoft.AzureStackHCI/networkSecurityGroups`) |
| 🧱 | Windows Defender Firewall | `New-NetFirewallRule` |
| 🐧 | firewalld (RHEL / Fedora) | `firewall-cmd` rich rules and policies |
| 🌐 | Cisco ACL | IOS extended access lists |
| 🐧 | nftables | `nft -f` ruleset (`table inet`) |
| 🐧 | iptables (legacy) | `iptables -A` commands |
| 🛡️ | Cisco FMC (Firepower) | Terraform (`CiscoDevNet/fmc` 2.x: `fmc_access_control_policy`) |
| 🔥 | Palo Alto (PAN-OS) | Terraform (`PaloAltoNetworks/panos` 2.x: `panos_security_policy`, `panos_service`) |

## ✨ Features

- 📝 Rule table with inline editing, enable/disable, reorder, duplicate and delete
- 📚 Well-known endpoints (Any, Internet, RFC1918, public DNS) and services (HTTP(S), SSH, RDP, DNS, LDAP, SMB, WinRM, SQL and more)
- 🎛️ Extra columns that change with the selected target (priority, logging, zone, profile, applied-to scope and so on); firewalld rules can be permanent or runtime-only, per rule
- ✅ Validation: duplicate or empty names, invalid ports and CIDRs, allow any-any, shadowed rules
- 📥 CSV / spreadsheet import, 📋 copy and 💾 download of the generated output
- 🗂️ Rules are saved in your browser's local storage
- 🔗 Share link: the whole rule set is compressed into the URL hash (nothing is uploaded)
- ⚠️ Per-target warnings, e.g. no reject on Windows/Cisco, Windows block-before-allow, default-accept chains

## 🛠️ Develop

```sh
npm install
npm run dev     # 🚀 dev server
npm test        # 🧪 vitest: generator snapshots and unit tests
npm run build   # 📦 type-check and production build
```

Pushes to `main` deploy to GitHub Pages via `.github/workflows/pages.yml`. 🚢

## 🗺️ Roadmap / TODO

- [x] 🐧 nftables output
- [x] 🐧 iptables output
- [ ] 😈 FreeBSD ipfw output
- [ ] 🐡 pf output (FreeBSD / OpenBSD / OPNsense / pfSense)
- [ ] ☁️ AWS security groups and Azure NSGs (Terraform)
- [ ] ☸️ Kubernetes NetworkPolicy / Cilium
- [x] ⚠️ Per-target warnings for unsupported options (no reject on Windows, deny-only on Cisco)
- [ ] 🔄 Reverse import from `iptables-save`, `nft list ruleset` and NSX JSON
- [x] 🔗 Shareable links (rules encoded in the URL hash)
- [ ] 🏷️ Named address groups that expand per target
- [ ] 🔍 Diff view between two rule sets
- [x] 🧪 Unit tests for the generators
- [ ] 🧾 Verify generated syntax against real NSX, SDN, Azure Local, firewalld and Cisco systems

## ⚠️ Caveats

Generated output is a starting point. Provider schemas, cmdlet parameters and CLI flags vary by version, so review it against your environment before applying. Several parameter names (the SDN `AclRule*` objects, `az stack-hci-vm` flags, firewalld rich-rule `priority`, some predefined NSX service names) were written from documentation and memory and have not been tested against live systems.

Platform limits are not hidden: 🧱 Windows Firewall evaluates Block before Allow regardless of order, 🐧 firewalld zones only filter inbound traffic (outbound uses a policy), and 🌐 Cisco ACLs end in an implicit deny.
