// Reads a systemd `EnvironmentFile` (KEY=VALUE per line, `#` comments, optional single or double quotes) so the deploy
// command can learn the port and the allowed hosts. It returns plain values and never prints them.

export function parseEnvFile(text) {
  const out = Object.create(null);
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m === null) continue;
    let value = m[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}
