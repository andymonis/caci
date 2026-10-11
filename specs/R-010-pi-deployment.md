# Raspberry Pi Deployment — Specification

Oct 11, 2026 · @Andy

**Status: being built as D1 (T-171 to T-180).** An internal family test: the service runs on a Raspberry Pi in the house, family members use it from phones and laptops on the home Wi-Fi, and the owner updates it with one command over SSH.

## Overview

The service already runs anywhere Node 22.13 or later runs (`npm run serve`). This specification adds what is needed to run it **unattended on a Pi**: a dedicated account, a systemd service that restarts after power loss, an update command that pulls from GitHub and can undo itself, nightly snapshots of the databases, and a command that checks the Pi's state so problems can be reported without a screen share. It adds no feature to the product.

## Decisions

| ID | Decision | Reason |
|----|----------|--------|
| D1 | **Owner:** family members on the home Wi-Fi use it over **plain HTTP** (`CACI_ALLOW_INSECURE=true`, session cookies not `Secure`). HTTPS and remote access are later. | Simplest thing that lets the family try it; a trusted house network. |
| D2 | **Owner:** the **real Anthropic model** (`CACI_LLM=anthropic`). The key lives **only in an environment variable**, supplied by a root-and-service-only env file read by systemd. | The test is whether the idea works with real filing. |
| D3 | **Owner:** updates are **one command over SSH** that pulls from GitHub, builds and restarts. Nothing deploys by itself. | The owner decides when the family sees a change. |
| D4 | **Owner:** **nightly local snapshots** of both databases with rotation. | Survives mistakes and bad updates; an SD-card failure is a known residual risk. |
| D5 | **Owner:** worries about family members' personal data do **not block this milestone**; it is an internal proof of concept. The release gates of R-008 and R-009 (pseudonymisation, a data processing agreement and the provider's terms, a lawful basis, a risk assessment, a statement of who may use the service) **remain recorded for any use beyond this family test**. The README states plainly that notes and category names go to Anthropic, unanonymised. | The owner's call, 2026-10-11. No consent machinery is built. |
| D6 | A dedicated **no-login `caci` account** owns the app, the data and the process. Layout: `/opt/caci/app` (git checkout), `/var/lib/caci` (data, 0700), `/etc/caci/caci.env` (0640 root:caci), `/var/backups/caci` (snapshots, 0700). | Least privilege; the code, the data and the secret are separable. |
| D7 | systemd runs **`node scripts/serve.mjs`**, never `npm run serve` (which rebuilds on every start and could leave no `dist/` if a build fails). `Restart=on-failure`, started at boot after the network is up. | Predictable restarts; power loss recovery. |
| D8 | **The gate does not run on the Pi.** A deploy does `npm ci`, `npm run build` and a smoke check (the page answers 200, `/api/me` answers a JSON 401 with the API's headers). | The gate takes minutes and memory a Pi may not have; the owner runs it before pushing. |
| D9 | **Every deploy snapshots first. A failed deploy rolls back the code and restores that snapshot.** | An older build refuses a database written by a newer schema, so rolling the code back alone could leave a service that cannot start. |
| D10 | Snapshots use **`VACUUM INTO`**, then verify the copy. Rotation keeps the last 14 complete snapshots. A snapshot is a folder holding `graphs.db` and `users.db`, created owner-only. | Consistent while the service runs; no need to stop it. |
| D11 | `CACI_ALLOWED_HOSTS` lists the **exact** names and addresses (port included) the family uses; the service then refuses any other `Host`. Registration stays open until the family has accounts, then is switched off. The first account created is the administrator, so the owner registers first. | DNS-rebinding protection on a LAN service; an open door only as long as needed. |
| D12 | The only things the deploy tooling reads from the environment are its own settings; **the key is never printed, logged or put in a command line**. The doctor reports only that it is present. | A key in a process list or log is a leak. |

## Goals and non-goals

Goals: a Pi that starts the service at boot and after power loss; a one-command update with automatic rollback; nightly snapshots and a tested restore; a doctor command; a step-by-step runbook; everything but the real Pi testable here.

Non-goals: HTTPS, a reverse proxy, remote access, automatic updates, snapshots copied off the device, a persisted login throttle, more than one Pi, a container image, and anything about the personal-data release gates (D5).

## Layout and who runs what

| What | Where | Owner and mode |
|------|-------|----------------|
| Application checkout | `/opt/caci/app` | `caci`, normal |
| Data (`graphs.db`, `users.db`) | `/var/lib/caci` | `caci`, 0700 (files 0600) |
| Settings and the key | `/etc/caci/caci.env` | root:caci, 0640 |
| Snapshots | `/var/backups/caci` | `caci`, 0700 (files 0600) |
| The service | `caci.service` | runs as `caci` |
| Nightly snapshot | `caci-backup.service` and `caci-backup.timer` | runs as `caci` |
| The deploy command | `sudo node deploy/run.mjs [ref]` | root, drops to `caci` for git and npm |

## Update and rollback sequence

1. Preflight: Node at least 22.13 and `node:sqlite` loads; the checkout has no local changes; the ref has a strict shape (no leading dash, no spaces). Failing here changes nothing (exit 12).
2. Remember the current commit; take a snapshot.
3. Fetch and check out the ref; `npm ci`; `npm run build`. A failure here leaves the running service untouched and the commit restored.
4. Restart the service; wait for health (up to a time limit).
5. On any failure after step 3 began: stop the service, check out the remembered commit, reinstall and rebuild, **restore the snapshot**, start, check health. Exit 10 if that works, 11 if the rollback also failed (with what to do by hand). Success is exit 0.

## Backup and restore

- `npm run backup` snapshots both databases from `CACI_DATA_DIR` into `<dest>/<UTC timestamp>/`, verifies each file (integrity, application id, schema version), rotates only complete snapshots, and refuses a destination inside the data folder.
- `npm run restore -- <snapshot> --yes` verifies first, copies the current files aside into a `pre-restore-<time>` folder, replaces the data files and removes stale `-wal` and `-shm` files. The service must be stopped.
- A snapshot taken by a newer build than the one restoring it is refused.

## Functional requirements

| ID | Requirement |
|----|-------------|
| D-FR-01 | A snapshot of a live database is a consistent state, never half a transaction, created owner-only and verified before it counts. |
| D-FR-02 | The backup command never deletes the newest good snapshot, never counts a partial one, and exits 0, 1 or 2 as described. |
| D-FR-03 | The restore command changes nothing until the snapshot is verified and the current files are copied aside. |
| D-FR-04 | The deploy command follows the sequence above, and its exit codes are 0, 10, 11 and 12. |
| D-FR-05 | The service unit runs as `caci`, restarts on failure, starts after the network is up, and is hardened (no new privileges, read-only system, writes only to the data and backup folders). |
| D-FR-06 | The install script is idempotent, never overwrites the env file or data, never downloads and runs anything, and has a dry-run mode. |
| D-FR-07 | The doctor reports one line per check with pass, warn or fail and what to do, and exits non-zero on any fail. |
| D-FR-08 | The example env file parses with the service's own configuration parser and contains no secret. |

## Threats and controls

| Threat | Control |
|--------|---------|
| The key leaks (process list, log, repository, backup, response) | It exists only in the env file (0640 root:caci), is read by systemd, is never an argument, is not part of any snapshot (snapshots hold the databases only), and the doctor and deploy never print it. |
| Anyone on the Wi-Fi can reach the service | Plain HTTP on a trusted network is accepted (D1); `CACI_ALLOWED_HOSTS` limits `Host`; the runbook limits the port to the home network with the firewall; registration is switched off once the family has accounts. |
| A bad deploy leaves the family without a service | The build happens before the service is touched; a failed health check rolls back the code and the data (D9). |
| Power loss or SD-card failure | SQLite with a write-ahead log survives power loss; systemd restarts at boot; nightly snapshots are on the same card (residual risk: a dead card loses both). |
| A command injected through the deploy ref | The ref has a strict shape and commands run without a shell, as argument arrays. |
| A restore overwrites good data with a bad snapshot | Verification first, the current files copied aside, `--yes` required. |

Each threat's covering tests are named in the milestone's tasks (T-172 to T-180); this milestone does not extend `review.test.ts`, because it adds no feature to the product.

## Residual risks

1. **Plain HTTP.** Session cookies and notes cross the Wi-Fi in clear; anyone on that network can read them.
2. **Family data goes to Anthropic, unanonymised** (D5). The release gates stand for anything beyond this test.
3. **Snapshots are on the same SD card** as the data.
4. **A Pi's clock** can start in the past without a battery; sessions and expiries depend on it (the doctor checks).
5. **Scrypt is slow on a Pi** and the service has no cap on concurrent hashing (the doctor times one hash).
6. **I could not run any of this on a real Pi.** The tooling is tested here with stubs; the owner's hand run is the proof, and is recorded as pending until done.

## Acceptance criteria

| ID | Given / When / Then |
|----|---------------------|
| D-AC-01 | Given a database being written to, when it is snapshotted, then the copy opens, passes its integrity check and holds a consistent state. |
| D-AC-02 | Given a service with accounts, circles and notes, when it is backed up, changed, stopped and restored, then everything from the snapshot is back and a login works. |
| D-AC-03 | Given more snapshots than the keep limit, when a backup runs, then the oldest complete ones go and the newest good one stays. |
| D-AC-04 | Given a deploy whose build fails, when it runs, then the running service is untouched. |
| D-AC-05 | Given a deploy whose health check fails, when it runs, then the previous commit is running again with the snapshot restored, and the exit code is 10. |
| D-AC-06 | Given a ref with a leading dash, a space or a shell metacharacter, when deploy is run, then nothing changes and the exit code is 12. |
| D-AC-07 | Given the example env file, when it is parsed, then it is valid configuration and holds no secret. |
| D-AC-08 | Given the install script run twice, when the second run ends, then nothing changed and no existing env file or data was touched. |
| D-AC-09 | Given any combination of check outcomes, when the doctor runs, then each is one line, the key is never printed, and the exit code is non-zero exactly when a check fails. |
| D-AC-10 | Given the runbook, when its commands, paths, units and settings are compared with the code, then they all exist and agree. |
