import { blankRule, newId } from './model'
import type { Rule, TargetId } from './model'

export interface ShareState {
  rules: Rule[]
  target: TargetId
  policyName: string
}

const VERSION = '1'
const PREFIX = 's='

const toB64Url = (bytes: Uint8Array) => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromB64Url = (text: string) => {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

const pipe = async (data: Uint8Array, stream: CompressionStream | DecompressionStream) => {
  const writer = stream.writable.getWriter()
  void writer.write(data as BufferSource)
  void writer.close()
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}

// Only fields that differ from a blank rule are kept, which keeps links short.
const compact = (rule: Rule): Partial<Rule> => {
  const blank = blankRule() as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rule)) {
    if (key !== 'id' && value !== blank[key]) out[key] = value
  }
  return out as Partial<Rule>
}

export const encodeState = async (state: ShareState): Promise<string> => {
  const json = JSON.stringify({ t: state.target, n: state.policyName, r: state.rules.map(compact) })
  const bytes = await pipe(new TextEncoder().encode(json), new CompressionStream('deflate-raw'))
  return `${PREFIX}${VERSION}.${toB64Url(bytes)}`
}

export const decodeState = async (fragment: string): Promise<ShareState | null> => {
  const clean = fragment.replace(/^#/, '')
  if (!clean.startsWith(PREFIX)) return null
  const [version, payload] = clean.slice(PREFIX.length).split('.')
  if (version !== VERSION || !payload) return null
  try {
    const bytes = await pipe(fromB64Url(payload), new DecompressionStream('deflate-raw'))
    const data = JSON.parse(new TextDecoder().decode(bytes)) as { t: TargetId; n: string; r: Partial<Rule>[] }
    if (!Array.isArray(data.r)) return null
    return {
      target: data.t,
      policyName: data.n ?? 'generated',
      rules: data.r.map((r) => ({ ...blankRule(), ...r, id: newId() })),
    }
  } catch {
    return null
  }
}

export const shareUrl = async (state: ShareState): Promise<string> =>
  `${location.origin}${location.pathname}#${await encodeState(state)}`
