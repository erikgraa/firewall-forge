import providers from './providers.json'

export type ProviderKey = keyof typeof providers

// Versions come from providers.json, which scripts/update-providers.mjs refreshes from the Terraform Registry at build time.
export const providerConstraint = (key: ProviderKey): string => `~> ${providers[key].version}`

export const requiredProviders = (...keys: ProviderKey[]): string =>
  `terraform {
  required_providers {
${keys
  .map((k) => {
    const p = providers[k]
    return `    ${p.name} = {\n      source  = "${p.source}"\n      version = "${providerConstraint(k)}"\n    }`
  })
  .join('\n')}
  }
}
`
