# Changelog

Notable user-facing changes are recorded here. Entries follow the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

<!-- Add changes here as they are made; do not invent entries for earlier releases. -->

### Added

- One-click SSH, Web and DNS starter templates with decorative icons: one SSH rule, one HTTPS rule or two DNS rules, disabled until the user edits/reviews addresses and enables them. New workspaces start empty while existing saved rules remain intact.
- Experimental Flat / Sections organization with Unsectioned, named collapsible sections, section-local additions, drag/drop and accessible Move and up/down controls. Moves change actual rule order; section metadata remains temporary and is excluded from saved/exported/shared data.
- Optional one-policy-per-section NSX output for Terraform, REST PowerShell and SDK PowerShell, plus group comments and compact commands in Windows PowerShell output. Deployment order and resource-identity changes require review; no default-deny controls or generation are included.
- Distinct action/output-format colors, equal-sized boxed product controls and decorative button icons, with clear selected and keyboard-focus states in both themes.
- A trailing `enabled` CSV column and matching import support to preserve disabled rules; older files without the column retain existing defaults and positional fields.
- This changelog and guidance for future release notes.
- Live SVG rule-intent topology with linked Rules / Topology tabs, shared editing and selection, search, disabled-rule visibility, MikroTik chain filters, and target-aware validation. The diagram shows configured matchers and decisions, not discovered devices or guaranteed reachability ([#36](https://github.com/erikgraa/firewall-forge/issues/36)).
- Collapsible Policy workspace, expanded by default and preserving rule data and the selected Rules / Topology tab when collapsed.
- MikroTik RouterOS 7.x IPv4 filter generation as append-only `.rsc`, with Auto/input/forward/output chain controls, logging, CSV/JSON/share roundtrips, chain-aware warnings and blocking validation for unsupported or unsafe rules ([#34](https://github.com/erikgraa/firewall-forge/issues/34)).
- MikroTik Terraform output using the community `terraform-routeros/routeros` 1.x provider, native filter resources and managed ordering, HTTPS credential variables, and an error guard against applying blocked output.

### Fixed

- Firewalld Ansible policy setup and policy-rule tasks now check state before adding configuration, making repeat runs idempotent.

## Release process

There are no published releases yet. When preparing a release, use a `vMAJOR.MINOR.PATCH` Git tag following Semantic Versioning, move the completed entries from **Unreleased** into a dated version section, and start a fresh **Unreleased** section. Keep entries concise and user-facing, grouped under **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**, or **Security** as appropriate. Record only changes supported by the merged work; do not add historical entries retroactively.
