// Where everything lives on the Pi, in one place (R-010). The deploy command, the install script's checks, the systemd
// units' tests and the runbook's tests all compare themselves with this.

export const LAYOUT = Object.freeze({
  /** The no-login account that owns the code, the data and the process. */
  user: 'caci',
  /** The git checkout the service runs from. */
  appDir: '/opt/caci/app',
  /** `graphs.db` and `users.db`. */
  dataDir: '/var/lib/caci',
  /** The LLM controls (R-012): instructions, framing and limits, as text files in the checkout. */
  controlsDir: '/opt/caci/app/controls',
  /** Settings and the Anthropic key, read by systemd and by the deploy command. Never in the repository. */
  envFile: '/etc/caci/caci.env',
  /** Snapshots (a folder per snapshot). */
  backupDir: '/var/backups/caci',
  service: 'caci.service',
  backupService: 'caci-backup.service',
  backupTimer: 'caci-backup.timer',
  /** How many snapshots the nightly backup (and each deploy's) keeps. */
  keep: 14,
  /** The port when `CACI_PORT` is not set (the service's own default). */
  defaultPort: 8080,
  /** What `sudo node deploy/run.mjs` deploys when no ref is given. */
  defaultRef: 'origin/main',
});
