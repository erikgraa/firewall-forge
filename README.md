# Firewall rule forge

<img src="public/icon.svg" alt="Firewall rule forge icon" width="72" align="right" />

Define firewall rules once, generate configuration for many platforms. A static TypeScript + React app: everything runs in your browser and nothing is sent anywhere.

## Targets

| Target | Output |
| --- | --- |
| NSX DFW | Terraform (`vmware/nsxt`) |
| Windows Server SDN ACL | PowerShell and Network Controller REST JSON |
| Azure Local NSG | `az stack-hci-vm network nsg` commands |
| Windows Defender Firewall | `New-NetFirewallRule` |
| firewalld | `firewall-cmd` rich rules and policies |
| Cisco ACL | IOS extended access lists |

## Features

- Rule table with inline editing, enable/disable, reorder, duplicate and delete
- Well-known endpoints (Any, Internet, RFC1918, public DNS) and services (HTTP(S), SSH, RDP, DNS, LDAP, SMB, WinRM, SQL and more)
- Extra columns that change with the selected target (priority, logging, zone, profile, applied-to scope and so on)
- Validation: duplicate or empty names, invalid ports and CIDRs, allow any-any, shadowed rules
- CSV / spreadsheet import, copy and download of the generated output
- Rules are saved in your browser's local storage

## Develop

```sh
npm install
npm run dev
npm run build
```

## Caveats

Generated output is a starting point. Provider schemas, cmdlet parameters and CLI flags vary by version, so review it against your environment before applying. Several parameter names (the SDN `AclRule*` objects, `az stack-hci-vm` flags, firewalld rich-rule `priority`, some predefined NSX service names) were written from documentation and memory and have not been tested against live systems.

Platform limits are not hidden: Windows Firewall evaluates Block before Allow regardless of order, firewalld zones only filter inbound traffic (outbound uses a policy), and Cisco ACLs end in an implicit deny.
