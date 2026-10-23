import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VARIABLES } from '../src/service/config.ts';
import { EXIT } from './deploy.mjs';
import { EXAMPLE_HOSTS, SLOW_HASH_MS, SNAPSHOT_STALE_MS } from './doctor.mjs';
import { parseEnvFile } from './envfile.mjs';
import { LAYOUT } from './layout.mjs';

// The runbook says what to type on the Pi. These checks fail the build when it names something that does not exist
// or disagrees with the code, the units or the example settings.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const start = readme.indexOf('## Running on a Raspberry Pi\n');
const section = readme.slice(start, readme.indexOf('\n## ', start + 3));
const lower = section.toLowerCase();
const example = readFileSync(join(root, 'deploy', 'caci.env.example'), 'utf8');
const timer = readFileSync(join(root, 'deploy', 'caci-backup.timer'), 'utf8');
const steps = [...section.matchAll(/^### (\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]]);

describe('the Pi runbook in the README', () => {
  it('is there, with thirteen numbered steps in order and the extra parts', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(steps.map(([n]) => n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    for (const heading of ['### What goes where, and what leaves the house', '### Troubleshooting']) expect(section).toContain(heading);
    expect(section).toContain('specs/R-010-pi-deployment.md');
    expect(existsSync(join(root, 'specs', 'R-010-pi-deployment.md'))).toBe(true);
  });

  it('every npm script it runs exists, and every file in the repository it names exists', () => {
    for (const m of section.matchAll(/npm run ([\w:-]+)/g)) expect(pkg.scripts, m[1]).toHaveProperty(m[1]);
    for (const m of section.matchAll(/\b((?:deploy|scripts|specs)\/[\w.-]+\.(?:mjs|sh|md|service|timer|example))\b/g)) expect(existsSync(join(root, m[1])), m[1]).toBe(true);
    for (const m of section.matchAll(/\/opt\/caci\/app\/((?:deploy|scripts)\/[\w.-]+)/g)) expect(existsSync(join(root, m[1])), m[1]).toBe(true);
  });

  it('every CACI_ setting it names is one the service reads', () => {
    const names = new Set(section.match(/CACI_[A-Z_]+/g) ?? []);
    expect(names.size).toBeGreaterThan(0);
    for (const n of names) expect([...VARIABLES], n).toContain(n);
  });

  it('every ANTHROPIC key name it uses is the one the example file uses', () => {
    expect(section).toContain('ANTHROPIC_API_KEY');
    expect(Object.keys(parseEnvFile(example))).toContain('ANTHROPIC_API_KEY');
  });

  it('names the layout\'s paths, account and units exactly', () => {
    for (const value of [LAYOUT.appDir, LAYOUT.dataDir, LAYOUT.envFile, LAYOUT.backupDir, LAYOUT.service.replace('.service', ''), LAYOUT.backupTimer]) expect(section, value).toContain(value);
    expect(section).toContain(`\`${LAYOUT.user}\` account`);
    for (const unit of [LAYOUT.service, LAYOUT.backupService, LAYOUT.backupTimer]) expect(existsSync(join(root, 'deploy', unit)), unit).toBe(true);
    expect(section).toContain(`sudo node ${LAYOUT.appDir}/deploy/run.mjs`);
    expect(section).toContain(`sudo bash ~/caci-src/deploy/install.sh`);
  });

  it('the numbers it states are the code\'s: the port, how many snapshots, the hour of the timer, the exit codes', () => {
    expect(section).toContain(`http://192.168.1.50:${LAYOUT.defaultPort}/`);
    expect(section).toContain(`newest ${LAYOUT.keep} are kept`);
    expect(/OnCalendar=\*-\*-\* (\d\d:\d\d):00/.exec(timer)?.[1]).toBe('02:30');
    expect(section).toContain('(02:30;');
    for (const [name, code] of Object.entries({ DEPLOYED: 0, ROLLED_BACK: 10, ROLLBACK_FAILED: 11, REFUSED: 12 })) {
      expect(EXIT[name]).toBe(code);
      expect(section, `| ${code} |`).toContain(`| ${code} |`);
    }
    expect(section).toContain('Node 22.13');
    expect(section).toContain('scrypt is slow on a Pi');
    expect(SLOW_HASH_MS).toBe(2000);
    expect(SNAPSHOT_STALE_MS).toBe(36 * 3600_000);
  });

  it('the example allowed hosts in the runbook are the example file\'s', () => {
    expect(parseEnvFile(example).CACI_ALLOWED_HOSTS).toBe(EXAMPLE_HOSTS);
    expect(section).toContain(`\`${EXAMPLE_HOSTS}\``);
  });

  it('says the things a reader must not miss', () => {
    for (const phrase of [
      'Nothing here has been run on a real Pi',
      'Taking a brain off the Pi for testing',
      'sudo rm /var/backups/caci/ann-export.json',
      '(#exporting-a-brain)',
      "ssh <pi> 'sudo cat /var/backups/caci/ann-export.json'",
      'delete the copy on the Pi when you have it',
      'Set `ANTHROPIC_API_KEY`, and set `CACI_ALLOWED_HOSTS`',
      'CaCi needs Node 22.13 or later',
      'Do not pipe a download into a shell',
      'sudo bash ~/caci-src/deploy/install.sh --dry-run',
      '--dry-run',
      'Some Android phones cannot open `.local` names',
      'never overwrites the settings file',
      'so the key never lands in your shell history',
      'The key lives **only** here',
      'only your home network should reach it',
      'allow SSH **before** enabling',
      'Register yourself first',
      'the first account becomes the administrator',
      'CACI_ALLOW_REGISTRATION=false',
      'the Pi does not run the tests',
      '**snapshots the data first**',
      '**restores the snapshot**',
      'An update never changes `/etc/caci/caci.env`',
      'run the install script again',
      'The snapshots are on the same SD card',
      'Shut down with `sudo shutdown -h now`',
      'are sent to Anthropic, unanonymised',
      'plain HTTP',
      'HTTPS is not part of this setup, and the only remote access is a private Tailscale network (step 13), never a port opened to the internet',
      'release gates',
      'a data processing agreement',
      'pseudonymisation',
      'pre-restore-',
      'recover-admin',
      'the `controls/` folder of the checkout',
      'A bad file stops the service from starting',
      'says which file to fix',
    ]) expect(lower, phrase).toContain(phrase.toLowerCase());
  });

  it('step 13 (Tailscale): its commands, settings and doctor lines agree with the code and the example, it never pipes a download into a shell and never recommends Funnel', () => {
    const step = section.slice(section.indexOf('### 13.'), section.indexOf('### What goes where'));
    expect(step.length).toBeGreaterThan(1500);
    expect(step).toContain('specs/R-010-pi-deployment.md');
    for (const m of step.matchAll(/CACI_[A-Z_]+/g)) expect([...VARIABLES], m[0]).toContain(m[0]);
    for (const m of step.matchAll(/npm run ([\w:-]+)/g)) expect(pkg.scripts, m[1]).toHaveProperty(m[1]);
    expect(step).toContain('npm run doctor');
    // the firewall line is one interface and one port, and the port is the service's
    expect(step).toContain(`sudo ufw allow in on tailscale0 to any port ${LAYOUT.defaultPort} proto tcp`);
    expect(step).toContain(`sudo ufw delete allow in on tailscale0 to any port ${LAYOUT.defaultPort} proto tcp`);
    expect(step).not.toMatch(/ufw allow (?!in on tailscale0)[^\n]*\b8080\b(?![^\n]*from)/);
    // the allowed-hosts example is the example file's tailnet block, home names first, each with the port
    const block = example.split('\n').find((l) => /^#\s*CACI_ALLOWED_HOSTS=.*ts\.net/.test(l)).replace(/^#\s*/, '');
    expect(step).toContain(block);
    expect(step).toContain('sudo systemctl restart caci');
    // fetched, read, then run; never piped
    expect(step).toContain('curl -fsSL https://tailscale.com/install.sh -o ~/tailscale-install.sh');
    expect(step).toContain('less ~/tailscale-install.sh');
    expect(step).toContain('sudo sh ~/tailscale-install.sh');
    expect(step).not.toMatch(/curl[^\n]*\|\s*(sudo\s+)?(ba)?sh/);
    expect(step).not.toMatch(/\|\s*(sudo\s+)?(ba)?sh\b/);
    // Funnel is only ever named to forbid it or to say how to turn it off
    for (const line of step.split('\n').filter((l) => /funnel/i.test(l))) expect(line, line).toMatch(/never|publishes|fails|if funnel|serve reset|whole internet/i);
    expect(step).not.toMatch(/tailscale funnel (on|--)/i);
    expect(step).not.toMatch(/tailscale serve --/i);
  });

  it('step 13 says the things a reader must not miss', () => {
    const step = section.slice(section.indexOf('### 13.'), section.indexOf('### What goes where')).toLowerCase();
    for (const phrase of [
      'no router port is opened',
      'only devices signed in to your tailnet can reach the pi',
      'for **you only** for now',
      '**never use tailscale funnel**',
      'whole internet',
      'the account is the front door',
      'second sign-in step',
      'fetched, read and then run',
      'do not pipe a download into a shell',
      'magicdns',
      'key expiry',
      'the service refuses any `host` that is not listed',
      'keep the home rule from step 8',
      '**not secure**',
      'tailscale encrypts the traffic between your phone and the pi',
      'encrypted by tailscale',
      'warns if the name is missing from `caci_allowed_hosts`',
      'fails if funnel is on',
      'sudo tailscale serve reset',
      '**turning it off:**',
      'sudo tailscale down',
      '**adding someone later:**',
      'caci_allow_registration=true',
      'the https alternative, not set up here',
      'public certificate logs',
      "which devices talk to each other and when, but not the content",
      'a lost phone or laptop',
      'the notes still go to anthropic',
      'nothing in this step has been run on a real pi or tailnet',
      'keep the output of `npm run doctor`',
    ]) expect(step, phrase).toContain(phrase);
  });

  it('the step before it points at step 13 and the troubleshooting table has the away-from-home row', () => {
    expect(section).toContain('step 13 adds one more rule, for the Tailscale interface only');
    expect(section).toContain('| Works at home, not away from home |');
    expect(lower).toContain('the only remote access is a private tailscale network');
  });

  it('never tells the reader to put the key on a command line, in the repository, or to pipe a download into a shell', () => {
    expect(section).not.toMatch(/ANTHROPIC_API_KEY=\S*sk-ant/);
    expect(section).not.toMatch(/curl[^\n]*\|\s*(sudo\s+)?(ba)?sh/);
    expect(section).not.toMatch(/export ANTHROPIC_API_KEY/);
    expect(section).not.toMatch(/npm run (users|serve)\b/); // those rebuild dist while the service runs
  });
});
