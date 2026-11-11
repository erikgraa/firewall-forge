# Changelog

Notable user-facing changes are recorded here. Entries follow the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

<!-- Add changes after v0.9.0 here; do not invent entries for earlier releases. -->

## [0.9.0] - 2026-11-11

Azure Firewall Policy script outputs. Generated configuration remains a reviewable starting point, not a live-validated deployment. Full-group replacement and the intentional Terraform/Bicep collection-name changes require deployment review.

### Added

- Azure Firewall Policy PowerShell (Az.Network) and Azure CLI (REST/Bash) network-rule outputs with local review-only defaults, explicit apply consent, DNS-proxy checks and documented full-group replacement scope. Enhancement [#49](https://github.com/erikgraa/firewall-forge/issues/49).
- Strict validation for unsupported Azure script mappings, with no executable output for invalid or all-disabled policies. Credentials/execution stay outside the browser; no live Azure deployment was performed.

### Changed

- Azure Firewall PowerShell now emits native splatted hashtables, arrays and Az.Network rule/collection constructors instead of embedded ARM JSON. Review-only execution prints the construction code without loading modules or contacting Azure; apply and replacement safeguards are unchanged.

### Fixed

- Azure Firewall shared collection planning now emits valid, unique names instead of `--`, and retains explicit wildcard addresses. Terraform/Bicep collection names change intentionally; review existing deployments before applying.

## [0.8.5] - 2026-11-11

Compatible improvements since v0.8.0. Versions 0.8.1–0.8.4 were not published; this release does not imply intermediate releases.

### Added

- Versioned browser-local workspace, JSON and share-link persistence for section titles, stable IDs, membership and NSX separate-policy layout, preserving exact evaluation order and empty sections. Older rule-only formats remain readable.
- Safe handling of malformed/stale section references and unsupported saved workspace versions, plus guarded section-aware JSON append without silent section identity merging.

### Changed

- Replaced obsolete temporary-section notices with accurate persistence guidance. Windows section warnings now appear only for populated named sections and clarify that sections are editor organization, not native Windows policy objects.
- CSV remains rule-only, with relevant section-loss disclosures; JSON/share links preserve the sectioned workspace. Flat view remains the default and presentation preferences are not persisted.
- Give Add rule buttons a distinct, theme-aware amber accent in Flat, Sections and Topology views, retaining existing placement, behavior and keyboard-focus indicators.
- Move production links, canonical metadata and Open Graph/Twitter image URLs to `https://firewallforge.graa.dev/`, with documented administrator-managed Pages/DNS/HTTPS requirements.
- Bump the package and lockfile to 0.8.5; the existing build-time package version injection supplies the footer.

### Validation and limitations

- This remains an unofficial, pre-1.0 testing tool. Automated tests and production builds do not establish live firewall validation or production readiness; review [docs/SOURCES.md](docs/SOURCES.md) and generated configuration before deployment.
- Sections remain experimental. CSV and older rule-only formats cannot preserve section metadata; legacy formats remain readable. Section moves change evaluation order, and NSX separate-policy deployment/resource identity changes require review.
- This release contains only merged changes since v0.8.0; guarded Cisco FMC Ansible support in still-open PR #45 is not included.
- No target-aware default-deny or full-hardening-policy guarantee is added. Old-host HTTPS redirects and social-preview cache refreshes remain outside the release workflow.

## [0.8.0] - 2026-11-10

Initial pre-1.0 version baseline. It collects the existing browser-only multi-target rule editor/generators, import/export/share support, and the merged improvements below. No earlier numbered releases are implied.

### Added

- A package/lockfile version baseline of 0.8.0, a footer version derived from the package at build time, and a README badge linked to published GitHub releases.
- Static Open Graph and Twitter-card metadata with canonical production URLs and a generic PNG preview based on the existing app logo, for link previews without JavaScript execution or user-policy content.
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

### Changed

- Give SSH, Web and DNS starter cards distinct teal, blue and purple accents, tinted backgrounds, icon tiles and service badges in both themes, retaining text labels and keyboard-focus indicators.

### Fixed

- Leave all-disabled firewalld, iptables, nftables and Cisco ACL Ansible output blank instead of generating warning-only comments or empty configuration tasks. Keep the UI deployment warning and mixed-input code warnings; PAN-OS Ansible native disabled rules remain unchanged.
- Retain disabled rules using native states in Windows, NSX, PAN-OS, FMC and MikroTik outputs, including disabled-only sections, dependencies and ordering. Unsupported formats still omit disabled rules but warn in the UI and generated code; invalid retained rules block output rather than generate a partial managed policy.
- Show the experimental-sections warning only in Sections view, not the default Flat view.
- Dismiss the latest SSH/Web/DNS addition notice after changing one of its new rules' source or destination in Rules or Topology, without enabling the rules.
- Firewalld Ansible policy setup and policy-rule tasks now check state before adding configuration, making repeat runs idempotent.

### Validation and limitations

- Automated generator/UI tests and production type-check/build validation are available; these do not establish complete live firewall validation for every target/output. Review [docs/SOURCES.md](docs/SOURCES.md) for product/tool versions and remaining parser/schema/live-test gaps.
- Disabled-rule support and deployment lifecycle vary by target. Omission does not disable deployed rules; review managed-resource deletions and append-only duplicates before applying.
- Section metadata is still temporary and absent from saved/imported/exported/shared rule data. The topology is a rule-intent preview, not a live network or packet simulator.
- Target-aware default-deny remains deferred. No full-hardening-policy or production-readiness guarantee is implied by this version baseline.

## Release process

Use `vMAJOR.MINOR.PATCH` tags following Semantic Versioning. Before 1.0, minor releases may include incompatible changes; use patches for compatible fixes and document breaking behavior and migrations. The initial baseline is 0.8.0, not a claim of earlier published releases. A **Pending release** heading is preparation only; use the actual publication date once approved.

1. Obtain explicit approval to commit/push/merge and to publish the tag/GitHub release. Preparing a package version or release notes alone does not authorize publication.
2. Use `npm version <version> --no-git-tag-version` to update `package.json` and both root lockfile version fields without prematurely creating a tag. Vite injects that package version into the app footer; there is no separate UI version to edit.
3. Finalize the matching changelog section with the publication date and accurate notes/limitations, retaining **Unreleased** for subsequent work. Run `npm test`, `npm run lint`, and `npm run build`; review the package/lock diff, footer and generated artifacts.
4. Commit the version/footer/changelog changes, open and merge the release PR, and verify CI/deployment. Fetch main and identify the exact merged release commit. Check `git show <release-commit>:package.json` and `git show <release-commit>:package-lock.json` for the matching version and verify that commit contains the release notes and footer injection. **Never tag the earlier 0.0.0 tree**, or an unrelated/newer commit by accident.
5. From the verified merged release commit, create the annotated tag: `git tag -a v0.8.0 <release-commit> -m "Firewall Forge v0.8.0"` (substitute the release version for later releases). Verify `git rev-parse v0.8.0^{commit}` equals that commit, then push only the intended tag with `git push origin v0.8.0`. Do not move an existing published tag.
6. Publish the GitHub release from that existing tag with `gh release create v0.8.0 --verify-tag --title "Firewall Forge v0.8.0" --notes-file <reviewed-release-notes-file>`. Use the corresponding changelog section, validation evidence and limitations as the reviewed notes; do not rely solely on auto-generated commit lists. `--verify-tag` prevents implicit tag creation on an unchecked commit.
7. Verify the tag/release version and commit, production footer, and release badge. Tags/releases do not trigger the current Pages/container workflows; main pushes deploy Pages and publish containers, and scheduled provider refreshes can rebuild the same app version. The latest-release badge updates only after GitHub publication and cache refresh; a package bump or tag alone is insufficient.

Keep changelog entries concise and user-facing, grouped under **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**, or **Security** as appropriate. Record only supported changes; do not add historical release sections retroactively.
