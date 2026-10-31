const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const token = /(#[^\n]*|\/\/[^\n]*|(?<![^\n])![^\n]*)|("(?:[^"\\\n]|\\.)*"|'[^'\n]*')|(\s--?[A-Za-z][\w-]*)|(\$[A-Za-z_]\w*)|(\b(?:resource|rule|az|firewall-cmd|iptables|table|chain|New-NetFirewallRule|permit|deny|remark|interface|New-Object|New-NetworkControllerAccessControlList)\b|^ip access-list)/gm

export const highlight = (code: string): string =>
  escapeHtml(code).replace(token, (m, comment, str, flag, variable, kw) => {
    if (comment) return `<span class="t-c">${comment}</span>`
    if (str) return `<span class="t-s">${str}</span>`
    if (flag) return `<span class="t-f">${flag}</span>`
    if (variable) return `<span class="t-v">${variable}</span>`
    if (kw) return `<span class="t-k">${kw}</span>`
    return m
  })
