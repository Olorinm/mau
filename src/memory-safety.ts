/** Heuristic screening adapted from Hermes tools/threat_patterns.py, MIT © 2025
 * Nous Research, main ef75bc708867e3884cb40a91363be6dc6fddc034. See NOTICE.
 * Defense in depth only, not a guarantee against prompt injection. */
const filler = String.raw`(?:\w+\s+){0,8}`;
const rules: Array<[string, RegExp]> = [
  ["instruction_override", new RegExp(String.raw`ignore\s+${filler}(?:previous|all|above|prior)\s+${filler}instructions`, "i")],
  ["system_override", /system\s+prompt\s+override/i],
  ["disregard_rules", new RegExp(String.raw`disregard\s+${filler}(?:your|all|any)\s+${filler}(?:instructions|rules|guidelines)`, "i")],
  ["remove_restrictions", new RegExp(String.raw`act\s+as\s+(?:if|though)\s+${filler}you\s+${filler}(?:have\s+no|don't\s+have)\s+${filler}(?:restrictions|limits|rules)`, "i")],
  ["hidden_instructions", /<!--[\s\S]{0,512}?(?:ignore|override|system|secret|hidden)[\s\S]{0,512}?-->/i],
  ["hidden_html", /<div[^>]{0,2048}style\s*=\s*["'][^"']{0,2048}display\s*:\s*none/i],
  ["translated_execution", /translate[^\n]{0,500}into[^\n]{0,200}and\s+(?:execute|run|eval)/i],
  ["conceal_from_user", new RegExp(String.raw`do\s+not\s+${filler}tell\s+${filler}the\s+user`, "i")],
  ["identity_override", new RegExp(String.raw`you\s+are\s+${filler}now\s+(?:a|an|the)\b|pretend\s+${filler}(?:you\s+are|to\s+be)`, "i")],
  ["prompt_extraction", new RegExp(String.raw`output\s+${filler}(?:system|initial)\s+prompt`, "i")],
  ["safety_override", new RegExp(String.raw`(?:respond|answer|reply)\s+without\s+${filler}(?:restrictions|limitations|filters|safety)`, "i")],
  ["role_update", new RegExp(String.raw`you\s+have\s+been\s+${filler}(?:updated|upgraded|patched)\s+to`, "i")],
  ["agent_registration", /name\s+yourself\s+\w+|register\s+(?:as\s+)?(?:a\s+)?node|(?:heartbeat|beacon|check-in)\s+(?:to|with)|pull\s+(?:down\s+)?(?:new\s+)?tasks?\b|connect\s+to\s+the\s+network|you\s+must\s+(?:\w+\s+){0,3}(?:register|connect|report|beacon)/i],
  ["execution_constraint", /only\s+use\s+one-liners|never[^\n]{0,200}(?:create|write)[^\n]{0,200}(?:script|file)[^\n]{0,200}disk/i],
  ["environment_tampering", /unset\s+\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC)\w*/i],
  ["command_control", /\b(?:cobaltstrike|sliver|havoc|mythic|metasploit|brainworm)\b|\bc2\s+(?:server|channel|infrastructure|beacon)|command\s+and\s+control/i],
  ["secret_exfiltration", /\b(?:curl|wget)\b[^\n]{0,2048}\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b/i],
  ["credential_file", /\bcat\b[^\n]{0,2048}(?:\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i],
  ["network_exfiltration", /\b(?:send|post|upload|transmit)\b[^\n]{0,500}\b(?:to|at)\s+https?:\/\//i],
  ["context_exfiltration", /\b(?:include|output|print|share)\b[^\n]{0,500}(?:conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)/i],
  ["ssh_keys", /authorized_keys/i],
  ["ssh_modification", /(?:\b(?:echo|cat|cp|mv|dd|tee|install|printf|rsync|scp|ln|append|add|write|sed|chmod|chown|truncate|rm|touch|curl|wget|git)\b|open\(|>>?)[^\n]{0,500}(?:\$HOME|~)\/\.ssh/i],
  ["hermes_credentials", /(?:\$HOME|~)\/\.hermes\/\.env/i],
  ["instruction_file_modification", /\b(?:update|modify|edit|write|change|append|add\s+to)\b[^\n]{0,500}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules|\.hermes\/config\.yaml|SOUL\.md)/i],
];
export function scanMemory(text: string): string[] {
  const found = new Set<string>();
  if (/[\u200B-\u200D\u2060\u2062-\u2064\uFEFF\u202A-\u202E\u2066-\u2069]/u.test(text)) found.add("invisible_unicode");
  const normalized = text.normalize("NFKC");
  if (normalized.length > 65536) found.add("scan_limit_exceeded");
  const scanned = normalized.slice(0, 65536);
  for (const [name, expression] of rules) if (expression.test(scanned)) found.add(name);
  for (const match of scanned.matchAll(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{20,})/gi)) {
    if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(match[1]!)) found.add("hardcoded_secret");
  }
  return [...found];
}
