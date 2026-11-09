<div align="center">

<img src="public/icon.svg" alt="Firewall Forge icon" width="120" />

# 🔥 Firewall Forge

**Define your firewall rules once — forge config for every platform.** 🛡️

A static TypeScript + React app. Everything runs in your browser, nothing is sent anywhere. 🔒

🌐 [firewall-forge.graa.dev](https://firewall-forge.graa.dev)

</div>

> ⚠️ **Community-driven, unofficial tool.** Firewall Forge is an independent open-source project and is **not affiliated with, endorsed by, or supported by any vendor**. All product names and trademarks (VMware, NSX, Broadcom, Microsoft, Azure, Cisco, Palo Alto Networks, Red Hat and others) belong to their respective owners and are used for identification only. Output is provided as is, without warranty.

## 🎯 Targets

| | Target | Output |
| --- | --- | --- |
| ☁️ | NSX DFW | Terraform (`vmware/nsxt`) or PowerShell (`VMware.Sdk.Nsx.Policy` module, or the Policy REST API via `Invoke-RestMethod`); selectable DFW category (Emergency, Infrastructure, Environment, Application); optionally project-scoped (`nsxt_policy_project` data source + `context` block, project-scoped cmdlet / API path) |
| 🪟 | Windows Server SDN ACL | PowerShell (Network Controller cmdlets) |
| 🔥 | Azure Firewall (policy) | Terraform (`azurerm_firewall_policy_rule_collection_group`) or Bicep (`Microsoft.Network/firewallPolicies/ruleCollectionGroups`), network rules |
| 🔷 | Azure Local NSG | `az stack-hci-vm network nsg` commands, or Bicep (`Microsoft.AzureStackHCI/networkSecurityGroups`) |
| 🧱 | Windows Defender Firewall | `New-NetFirewallRule` |
| 🐧 | firewalld (RHEL / Fedora) | `firewall-cmd` rich rules and policies, or Ansible (`ansible.posix.firewalld`) |
| 🌐 | Cisco ACL | IOS extended access lists, Ansible (`cisco.ios.ios_acls`) or Terraform (`CiscoDevNet/iosxe`, IOS XE only) |
| 🐧 | nftables | `nft -f` ruleset (`table inet`), or Ansible |
| 🐧 | iptables (legacy) | `iptables -A` commands, or Ansible (`ansible.builtin.iptables`) |
| 🛡️ | Cisco FMC (Firepower) | Terraform (`CiscoDevNet/fmc` 2.x: `fmc_access_control_policy`) |
| 🔥 | Palo Alto (PAN-OS) | Terraform (`PaloAltoNetworks/panos` 2.x: `panos_security_policy`; or 1.x: `panos_security_rule_group`) or Ansible (`paloaltonetworks.panos`) |
| 📡 | MikroTik RouterOS 7.x | Native append-only `.rsc` or Terraform-managed IPv4 filter rules (`input` / `forward` / `output`); no NAT or browser-to-router connectivity |

## ✨ Features

- 🌗 Light / dark mode toggle (follows your system by default, remembered per browser), with a matching icon for each
- 📂 Collapsible Policy workspace and Generated output, both expanded by default; collapsing preserves rules and the selected workspace tab
- 🧩 Platforms with switchable output formats (e.g. NSX: Terraform / PowerShell, Azure Local: az CLI / Bicep, Linux: native / Ansible)
- 🎨 Distinct Import / Export / Clear all action colors and decorative icons, neutral Rules / Topology view tabs, and format-specific output colors with selection checkmarks and keyboard focus states in both themes. Equal-sized product buttons sit in a separate labeled box. Action selectors use green ALLOW, red DROP and amber REJECT; native dropdown menus may retain operating-system styling
- 📝 Linked **Rules / Topology** tabs: inline rule editing, enable/disable, reorder, duplicate and delete, plus a live SVG rule-intent map with a shared editor, search, chain filters and disabled-rule visibility
- 📚 Well-known endpoints (Any, Internet, RFC1918, public DNS) and services (HTTP(S), SSH, RDP, DNS, LDAP, SMB, WinRM, SQL and more)
- 🎛️ Extra columns that change with the selected target (priority, logging, zone, profile, applied-to scope and so on); firewalld rules can be permanent or runtime-only, per rule
- ✅ Validation: duplicate or empty names, invalid ports and CIDRs, allow any-any, shadowed rules
- 📥 Import / export as CSV or JSON (switchable). JSON is lossless; CSV is spreadsheet-friendly and its columns follow the selected target (e.g. NSX adds scope / logging / notes, Azure Local adds priority), with a built-in template, 📋 copy and 💾 download of the generated output
- 🧰 New workspaces start empty, with configurable **SSH server**, **Web server** and **DNS server** starter templates. Templates append rules without replacing existing work; saved configurations are preserved
- 🗂️ Rules are saved in your browser's local storage
- 🔗 Share link: the whole rule set is compressed into the URL hash (nothing is uploaded)
- ⚠️ Per-target warnings, e.g. no reject on Windows/Cisco, Windows block-before-allow, default-accept chains

## 🧰 Starter templates

A new browser workspace starts with no rules; existing saved rules and shared configurations still load normally. Each icon-labelled **Starter templates** button adds its rules immediately, without a separate address form: **SSH** adds one TCP 22 rule, **Web** one HTTPS TCP 443 rule, and **DNS** two rules for UDP and TCP 53. All starters are **disabled**, with editable `Any` source/destination defaults. Set the intended client/server addresses in the normal rule editor and enable each rule only after review. No HTTP rule is silently added; use the editor or Add rule if HTTP is required.

Each application creates fresh IDs and unique names and inserts rules in recipe order at the end of Unsectioned, before later named sections if present, without changing existing rules. Templates can be used repeatedly, or you can add/import rules manually. The addition notice disappears when you change a source or destination on one of the newly added starters in the table or Topology. Disabled starters remain disabled in saved/exported/shared configurations and do not emit active firewall rules. CSV exports include a trailing `enabled` column; imports without it retain the legacy enabled-by-default behavior, including older headerless target-specific rows.

These are inbound **allow-rule starters**, not complete hardening policies. They do not add default-deny, NAT, established/related or return-traffic rules. Review addresses, evaluation order, priorities, zones, scope and the target's defaults before enabling/applying. For MikroTik, starters use `forward` for traffic through the router; change Chain to `input` for services on the router or `output` for router-originated traffic when appropriate. Templates do not restrict the editor's existing address capabilities. Empty workspaces show an output placeholder with Copy and Download disabled, rather than generating an empty firewall configuration.

## Disabled rules in generated output

Disabled rules are retained with a **native disabled state** in Windows PowerShell (`-Enabled False`, a text enum—not `$false`), NSX Terraform/REST/SDK (`disabled`), PAN-OS Terraform 1.x/2.x and Ansible (`disabled`), FMC Terraform (`enabled = false`), and MikroTik `.rsc`/Terraform (`disabled=yes` / `disabled = true`). Their matchers, ordering, service dependencies and generated identities remain present, including disabled-only Windows and NSX sections. Enabling a managed rule changes its native state rather than removing/recreating it solely because of the toggle.

Other output formats still omit disabled rules and show a warning both in the preview and copied/downloaded code. There is no generic Ansible/Terraform disable switch: omission can delete previously managed rules when replacing a policy or applying Terraform, and does **not** disable an existing append-only rule. We do not substitute `count = 0`, removal tasks or commented-out rules for a real disabled state. Saved/exported/shared rule data always retains the rules and their enabled state.

**Review existing deployments:** Windows `New-NetFirewallRule` and RouterOS `.rsc` still create/append rules; a newly generated disabled rule does not disable an earlier deployed copy. Update/disable those existing objects separately. Managed Terraform, NSX policy updates and PAN-OS Ansible can update their corresponding managed objects, subject to their existing identity and ownership rules. Policies containing retained disabled rules block generation/Copy/Download on validation errors instead of emitting a partial policy; blocked Terraform output includes an impossible version guard against accidental deletion. RouterOS validates every emitted rule, enabled or disabled. Native state fields were checked against the references and versions in [docs/SOURCES.md](docs/SOURCES.md); this is not live firewall verification.

## 🗂️ Experimental rule sections

**Flat list remains the default.** The experimental-sections warning appears only in **Sections** view, beneath the organization controls. Switch to **Sections** to create named collapsible sections alongside permanent **Unsectioned**. Drag a rule onto a section or use its Move menu to change its actual evaluation position. Within a section's contiguous run, drag above/below another rule or use the local up/down controls; disabled rules retain their positions and section boundaries are protected. Global position numbers show the underlying rule order, not an effective-policy simulation. Flat list keeps whole-list ordering controls.

Add rule sits at the bottom of Flat list, in each section footer, and below the Topology workspace. Templates, imports and duplication enter the end of Unsectioned, which can precede later named sections. Section-local Add rule appends directly to that section's evaluation position. No presentation-only sorting is performed.

**Section labels, membership and the separate-policy output selection are temporary:** they reset on reload and are not included in local storage, CSV / JSON or share links. The actual reordered rules and their fields remain saved/exported/shared normally. Reloaded rules return to Unsectioned and NSX returns to single-policy output. This is an experimental organizer, not a persisted policy-group data model; retain the reviewed generated artifact if you need to reproduce a deployment.

For **NSX Terraform, REST PowerShell and SDK PowerShell**, optionally enable **one policy per section**. Enabled and disabled rules are emitted in contiguous section order with unique policy and rule sequence numbers. Separate, repeated runs of the same section block this mode rather than silently sorting rules. Disabled-only sections retain policies with disabled rules; genuinely empty sections do not emit policies. Rule actions, matchers, direction, scope, logging, category and project context are retained. Review placement against existing NSX policies: sequence numbers are unique within this output, not reserved globally, and updates are not atomic across policies. Switching modes or regenerating after section metadata is lost changes generated resource identities; review Terraform plans for recreation/deletion, and manage obsolete REST/SDK policy objects manually. No catch-all deny is inserted.

For **Windows PowerShell**, section names appear as comments with spacing between sections, while adjacent commands within a section have no blank line between them. Sections do not change Windows' block-before-allow evaluation or create separate Windows policy objects. Other target formats retain their existing generators and use actual rule order where supported.

NSX policy/rule ordering and project/category fields were checked against [NSXT provider 3.12.0 documentation](https://github.com/vmware/terraform-provider-nsxt/blob/v3.12.0/docs/resources/policy_security_policy.md); the provider remains constrained to 3.x. Windows commands retain [`New-NetFirewallRule`](https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule?view=windowsserver2025-ps) semantics. Behavioral tests cover grouping and escaping; PowerShell syntax checks are separate from live verification. No live NSX deployment, grouped Terraform apply or Windows firewall application has been performed. Default-deny controls and target-aware fallback generation are deliberately not part of this change.

## 🗺️ Rule-intent topology

Switch between **Rules** and **Topology** in the collapsible Policy workspace. Both views edit the same saved rule set; table selection, imports, duplication, reordering and deletion are reflected in the diagram and generated output. Select a route or rule to edit its matchers, service, action and target-specific fields, or use **Open in Rules** to focus its table row. Search by name or address matcher, and optionally show disabled rules. Tabs support arrow keys/Home/End; routes support Enter/Space selection. Narrow screens stack the inspector and allow horizontal scrolling of the diagram.

The SVG shows **configured rule intent**, not discovered devices, live traffic, an effective-policy simulation or guaranteed reachability. Nodes are address matchers, including grouped presets and lists—not individual devices or generated resource counts. Route numbers preserve table order but do not simulate target evaluation. DROP/REJECT destination links are dashed matcher associations without delivery arrows; disabled routes have no arrows. Invalid matchers, services, ports and duplicate names are excluded with editable diagnostics rather than replaced with Any. Shared target warnings and generation guards still apply.

Only MikroTik native and Terraform output show `input` / `forward` / `output` lanes, using the same Auto/explicit-chain mapping as the generators. Other platforms use a generic policy context: scope, zones, priorities, inherited rules and platform defaults must be reviewed in the target-specific fields and warnings. No default deny, established/related or return-traffic rules are added. The Mermaid/zone-view and diagram-export roadmap remains a separate follow-up.

## 📡 MikroTik RouterOS

Generate native **RouterOS 7.x IPv4 filter** commands as `mikrotik-firewall.rsc`, entirely in the browser. Firewall Forge does not connect to routers. There is no NAT, IPv6, raw/mangle, custom-chain, interface/interface-list, connection-state or Ansible support, and no reverse `.rsc` import. Terraform is available as a separate output format with managed-rule lifecycle and ordering, described below.

- **Chain:** `Auto` maps Inbound to `input` (traffic **to the router**) and Outbound to `output` (traffic **from the router**). Select `forward` for traffic **through the router**. Explicit chains override Direction; the saved Direction is retained but its control is disabled.
- **Matchers:** literal IPv4 hosts/CIDRs (prefix 0–32), comma-separated address lists, Any (`*`), RFC1918 and public-DNS presets. Lists expand source × destination, preserving table/list order. `Internet`, IPv6, names/groups, empty list entries and malformed addresses block generation; they are never substituted with Any.
- **Actions and services:** ALLOW → `accept`, DROP → `drop`, REJECT → `reject reject-with=icmp-admin-prohibited`. TCP/UDP use destination ports and ascending ranges (0–65535); empty ports mean all ports. ICMP and ANY require empty ports. Names/notes become escaped comments; logging uses `log=yes` with the rule name as an escaped log prefix. The policy name is a descriptive label, not a RouterOS policy object. Logging destinations are not configured.
- **Unsupported inherited fields:** program, profile, scope, zones and runtime-only permanence block generation rather than broadening a rule. Clear these fields in the relevant target's editor or a JSON export before reimporting. RouterOS rules persist normally. Shared Priority is not applied: RouterOS `priority` matches packet priority, not evaluation order; table order controls the generated sequence.
- **Imports:** select MikroTik before importing CSV or a bare JSON array. Invalid JSON field types/enums are rejected, and invalid CSV actions, directions, protocols or conflicting service ports remain errors rather than being replaced by permissive defaults. JSON exports retain every rule field and Chain; older files without Chain default to Auto.
- **Append-only, not idempotent:** only `/ip firewall filter add` commands are emitted. Nothing existing is removed, reset or reordered. Reimporting creates duplicates. Earlier router rules can make the appended rules unreachable. Any rule error, including errors in retained disabled rules, blocks the entire configuration, including direct generator calls. Disabled rules are appended with `disabled=yes`; they do not disable existing copies.

**Review before applying:** filter chains accept packets when no rule matches. No catch-all deny, established/related accepts, FastTrack or return-traffic rules are inserted. Existing established/related accepts and FastTrack can bypass later deny rules; bridge filtering and hardware offload also affect which traffic reaches the IP firewall. Review the router's current rules and packet flow, and protect management access. These outputs are not a complete router-hardening template.

Download the ordinary `.rsc` file, review it, and upload it using your own router-management tools. **Do not rename it `.auto.rsc`**: that suffix can trigger automatic execution on upload. On RouterOS releases supporting import dry-run, check syntax without applying changes:

```routeros
/import file-name=mikrotik-firewall.rsc verbose=yes dry-run=yes
```

The minimum 7.x minor version supporting this check is not confirmed; inspect `/import` help on your device. After review and with an appropriate backup/recovery path, apply manually:

```routeros
/import file-name=mikrotik-firewall.rsc
```

Imports are not atomic: a device-side failure can leave earlier commands applied. Safe Mode can help with recovery, but its finite history can be exhausted by large imports; it is not a substitute for console access and a backup. Syntax/semantics were checked against the [current official filter CLI reference](https://manual.mikrotik.com/docs/cli-reference/ip/firewall/filter/) and [scripting documentation](https://manual.mikrotik.com/docs/developer-guides/scripting/), and covered by behavioral tests. **No RouterOS native parser, import dry-run or live firewall test has been performed**, and compatibility with every 7.x minor release is not guaranteed. See [configuration management](https://manual.mikrotik.com/docs/getting-started/configuration-management/) for import and Safe Mode details.

### Terraform-managed filters

Choose **MikroTik RouterOS → Terraform** to download `mikrotik-firewall.tf`. This uses the community-maintained [`terraform-routeros/routeros`](https://registry.terraform.io/providers/terraform-routeros/routeros/latest) provider, constrained to `~> 1.99` by `src/providers.json`; provider **1.99.1** was checked. It is not a MikroTik-official provider. The shared IPv4 validation, chain, matcher and action limitations above apply to both formats.

- **Lifecycle differs from `.rsc`:** Terraform creates and updates its managed `routeros_ip_firewall_filter` resources. Disabling a table rule retains its managed resource with `disabled = true`, preserving its identity and position. Removing a table rule removes it from configuration and can **delete it on apply**. An empty configuration can delete every previously managed rule; an all-disabled table instead retains disabled resources. Keep one configuration and state per router/rule set, and review the plan before applying; do not manage the same rules simultaneously through another state or repeated `.rsc` imports.
- **Ordering:** `routeros_move_items` references the managed filters in table/expansion order when there are at least two filters. Creation dependencies serialize initial additions; updates and moves are **not atomic**. This does not manage the whole rulebase or guarantee placement relative to existing/unmanaged rules, contiguity after external edits, or uninterrupted packet behavior during changes. Inspect the live order and keep management/recovery access before applying.
- **Resource identity:** addresses use the rule name plus source/destination expansion indices, remaining stable when table rows move. Renaming a rule recreates its resources; edits to an address list change the matchers associated with its indexed expansions. The policy name is descriptive only, not a separate namespace. Plan review is essential.
- **Invalid output is deliberately unapplyable:** errors in enabled or disabled rules disable Copy/Download and emit diagnostics plus an impossible `required_version = "< 0.0.0"` constraint. This prevents an invalid, otherwise empty configuration from destroying rules already in state. Fix the rules and regenerate; do not remove the guard to apply an invalid file.

Enable [RouterOS 7 REST over `www-ssl`](https://manual.mikrotik.com/docs/developer-guides/rest-api/) with a trusted certificate using your own management tools; the generator does not configure the service or upload anything. Restrict access and use an appropriately permissioned account. Supply `routeros_hosturl` (an `https://` base URL), `routeros_username` and sensitive `routeros_password` through Terraform's `TF_VAR_` environment variables or a secured, untracked variable file **outside the browser**. Certificate verification is enabled (`insecure = false`). For a private CA, the provider supports `ROS_CA_CERTIFICATE` pointing to its PEM certificate file. Never put credentials in Firewall Forge, share links or Git. Protect Terraform state, saved plans and local variable files; `sensitive` does not encrypt them.

On your own machine, initialize and validate the downloaded configuration, then review a plan before deciding whether to apply:

```sh
terraform init
terraform fmt -check
terraform validate
terraform plan
```

Local checks with **Terraform 1.16.6 / RouterOS provider 1.99.1** passed formatting and provider-backed validation for sample, template/Unicode escaping, mixed matcher expansion, single-filter and empty configurations; the blocked-output version guard was also checked. Provider schema inspection confirmed the emitted filter, move and connection fields. **No Terraform plan/apply, live router connection, or live rule-order/packet-behavior test has been performed.**

## 🛠️ Develop

```sh
npm install
npm run dev     # 🚀 dev server
npm test        # 🧪 vitest: generator snapshots and unit tests
npm run build   # 📦 type-check and production build
npm run update-providers   # 🔄 refresh Terraform provider versions from the registry
```

Pushes to `main` deploy to GitHub Pages via `.github/workflows/pages.yml`. 🚢

## 📋 Changelog

See [CHANGELOG.md](CHANGELOG.md) for user-facing changes and release-note guidance.

## 📚 Product and tool references

See [docs/SOURCES.md](docs/SOURCES.md) for product documentation, output-tool references, version information, and known validation gaps for each supported target.

🔄 **Provider versions stay current:** every Terraform output declares `required_providers` from `src/providers.json`. The Pages workflow runs `scripts/update-providers.mjs` before each build (and weekly on a schedule) to bump each provider to its latest release within the major version we generate for; if the registry is unreachable the committed versions are used. A new *major* version needs a manual update. Dependabot keeps npm packages and GitHub Actions up to date.

## 🗺️ Roadmap / TODO

- [x] 🐧 nftables output
- [x] 🐧 iptables output
- [ ] 😈 FreeBSD ipfw output
- [ ] 🐡 pf output (FreeBSD / OpenBSD / OPNsense / pfSense)
- [ ] ☁️ AWS security groups and Azure NSGs (Terraform)
- [x] 🔥☁️ Azure Firewall policy rule collection groups: Terraform and Bicep (network rules only)
- [ ] 🌍 Azure Firewall application rules (FQDN / FQDN tags) and DNAT rules
- [ ] ☸️ Kubernetes mode: a separate **Firewall | Kubernetes** switch with its own rule table (pod/VM label selectors, namespaces, ingress/egress) and outputs for NetworkPolicy and AdminNetworkPolicy first, then Antrea (vSphere Kubernetes), OVN EgressFirewall (OpenShift Virtualization), Cilium and Calico; warn that NetworkPolicy is allow-only
- [x] ⚠️ Per-target warnings for unsupported options (no reject on Windows, deny-only on Cisco)
- [ ] 🔄 Reverse import from `iptables-save`, `nft list ruleset` and NSX JSON
- [x] 🔗 Shareable links (rules encoded in the URL hash)
- [ ] 🏷️ Named address groups that expand per target
- [ ] 🔍 Diff view between two rule sets
- [ ] 🧰 Loadable configuration templates: create different example rule sets for common firewall scenarios, let users select and load a template into the rule table, and review before replacing their current rules; everything stays in the browser
- [x] 🧪 Unit tests for the generators
- [ ] 🧾 Verify generated syntax against real NSX, SDN, Azure Local, firewalld, Cisco and Palo Alto systems
- [x] 🗺️ Live SVG rule-intent topology with linked Rules / Topology tabs, shared editing, filtering and a collapsible Policy workspace ([#36](https://github.com/erikgraa/firewall-forge/issues/36))
- [ ] 🗺️ Mermaid diagrams generated from the rules: traffic flow, rule evaluation order (compact rectangles, not diamonds) and a zone view for Palo Alto / FMC; lazy-load Mermaid and offer Copy Mermaid / Download SVG
- [ ] 🤖 Cisco FMC Ansible (`cisco.fmcansible`) once the module names are checked
- [x] 🏢 NSX project-scoped (multitenancy) output for Terraform and PowerShell (optional project ID)
- [ ] 🔷 Azure Local Bicep: offer the newer `2026-07-01-preview` API version
- [x] 🔁 Make firewalld Ansible policy setup and policy-rule tasks idempotent with query-before-add checks
- [ ] 🔌 Attach generated ACLs to interfaces (Cisco `ios_acl_interfaces` / `iosxe_interface_ethernet`, NSX applied-to groups)

## ⚠️ Caveats

Generated output is a starting point. Provider schemas, cmdlet parameters and CLI flags vary by version, so review it against your environment before applying. Several parameter names (the SDN `AclRule*` objects, `az stack-hci-vm` flags, firewalld rich-rule `priority`, some predefined NSX service names) were written from documentation and memory and have not been tested against live systems.

Platform limits are not hidden: 🧱 Windows Firewall evaluates Block before Allow regardless of order, 🐧 firewalld zones only filter inbound traffic (outbound uses a policy), and 🌐 Cisco ACLs end in an implicit deny.

The firewalld Ansible output uses `ansible.posix.firewalld` for zone rules and checks policy state before adding policies, zone associations, or rich rules. These generated tasks are covered by unit tests, but have not been validated on a live firewalld host; review them against the firewalld version and policy configuration in your environment.

🐳 **Run it as a container** (Docker or Podman):

```sh
docker run --rm -p 8080:8080 ghcr.io/erikgraa/firewall-forge:latest
podman run --rm -p 8080:8080 ghcr.io/erikgraa/firewall-forge:latest
```

Then open http://localhost:8080. The image is a static nginx site (no runtime internet access needed) that runs as a non-root user, so it also works with rootless Podman. It is rebuilt nightly by `.github/workflows/container.yml` so it carries the latest Terraform provider versions; tags are `latest`, a date (`YYYYMMDD`) and the commit SHA. Build it yourself with `docker build -t firewall-forge .` or `podman build -t firewall-forge .`.
