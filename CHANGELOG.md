# Changelog

Notable user-facing changes are recorded here. Entries follow the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

<!-- Add changes here as they are made; do not invent entries for earlier releases. -->

### Added

- This changelog and guidance for future release notes.
- MikroTik RouterOS 7.x IPv4 filter generation as append-only `.rsc`, with Auto/input/forward/output chain controls, logging, CSV/JSON/share roundtrips, chain-aware warnings and blocking validation for unsupported or unsafe rules ([#34](https://github.com/erikgraa/firewall-forge/issues/34)).
- MikroTik Terraform output using the community `terraform-routeros/routeros` 1.x provider, native filter resources and managed ordering, HTTPS credential variables, and an error guard against applying blocked output.

### Fixed

- Firewalld Ansible policy setup and policy-rule tasks now check state before adding configuration, making repeat runs idempotent.

## Release process

There are no published releases yet. When preparing a release, use a `vMAJOR.MINOR.PATCH` Git tag following Semantic Versioning, move the completed entries from **Unreleased** into a dated version section, and start a fresh **Unreleased** section. Keep entries concise and user-facing, grouped under **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**, or **Security** as appropriate. Record only changes supported by the merged work; do not add historical entries retroactively.
