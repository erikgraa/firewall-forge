# Copilot instructions

Firewall Forge is a browser-only TypeScript and React app that generates firewall
configuration for multiple products and output formats. Keep rule data and
generation in the browser; do not send user data to a service.

## Current, idiomatic output

- When changing a generator, verify product behavior and syntax against current
  official product and tool documentation for the versions being targeted.
  Check provider schemas, module and cmdlet parameters, API versions, and
  deprecations rather than relying on memory or existing snapshots. Record
  relevant version constraints and limitations; do not claim verification that
  could not be performed.
- Prefer current, supported, idiomatic constructs for both the firewall product
  and the output tool. For example, respect NSX policy objects and firewalld
  zones and policies as well as Terraform resource semantics, Ansible module
  conventions, and PowerShell cmdlet conventions. Use native resources or
  modules where appropriate, and make repeated application safe and idempotent
  where the tool supports it.
- Preserve the user's rule intent, including action, direction, addresses, ports,
  ordering, priority, scope, logging, and persistence. Account for target-specific
  defaults and evaluation behavior; do not assume platforms are interchangeable.
  Do not silently broaden access or substitute a different meaning when a target
  cannot represent an option. Surface a clear warning or validation error and
  document any required manual steps.
- Keep supported versions and generated output compatible. Terraform provider
  constraints come from `src/providers.json` via `src/providers.ts`; the update
  script refreshes versions within each configured major. Treat major-version
  changes as schema migrations: verify compatibility and update generators,
  tests, and documentation together. Do not select a newer API or dependency
  solely because it is newer if it changes supported behavior.

## Changes and validation

- Check related generators and formats, validation and warnings, UI fields,
  import/export, and documentation when changing rule behavior. Keep the README's
  target descriptions and caveats accurate.
- Add focused behavioral tests in `src/forge.test.ts` for semantics and edge
  cases, not just snapshots. Update snapshots intentionally when output changes.
  Use the relevant tool's syntax, schema, or dry-run checks when available, and
  distinguish those checks from verification on a live firewall.
- Run the smallest relevant checks using `npm test`, `npm run lint`, and
  `npm run build` as appropriate. Report checks that could not be run and
  remaining unverified behavior.
