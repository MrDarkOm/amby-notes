# Amby sync server

A small server that stores your notes **encrypted**, so your devices can stay in step. It is a
blind store: the keys never reach it, so neither you nor anyone who gets a copy of its disk can
read what it holds. You run it on your own machine; one server can hold several people.

## What the server sees and what it cannot see

Your devices encrypt everything before sending it. The server **cannot read**:

- the text of your notes and attachments,
- the names of your files and folders, and the folder structure,
- the names of your devices and of your vaults,
- your password, your recovery code and any key (it keeps only hashes of what it must compare).

The server **does see**, and this cannot be hidden:

- the user names,
- how many files you have and roughly how big they are,
- when they changed, which device changed them, and from which IP addresses the requests come.

Because the server cannot read your data it also cannot recover it: if you lose both your password
and your recovery code, nobody can bring the data on the server back. The files on your own
devices stay as they are.

## Quick start (Docker, HTTPS included)

The simplest way is the ready-to-run kit with a prebuilt image
(`ghcr.io/mrdarkom/ambynotes-sync`): [AmbyNotes-SelfHost](https://github.com/MrDarkOm/AmbyNotes-SelfHost).
The steps below build the image from this source instead.

You need a machine with Docker, a DNS name pointing at it, and ports 80 and 443 open.

```bash
git clone https://github.com/MrDarkOm/amby-notes && cd amby-notes/sync/server
echo "AMBY_SYNC_DOMAIN=sync.example.org" > .env
docker compose up -d --build
```

Caddy (in the same compose file) gets and renews the HTTPS certificate itself. Check that the
server answers:

```bash
curl https://sync.example.org/v1/info
```

The server speaks plain HTTP only inside the compose network. Do not publish its port 8080
directly to the internet: passwords and notes must travel over HTTPS.

## Add a user

```bash
docker compose exec amby-sync amby-sync-server user add alice
```

It prints a **one-time code** valid for 24 hours. In the app, enter the server address
(`https://sync.example.org`), the user name and the code, then choose a password. The app creates
the keys and shows a recovery code: save it. Running `user add` again for a name that has not set
a password yet gives a new code and burns the old one.

```bash
docker compose exec amby-sync amby-sync-server user list
docker compose exec amby-sync amby-sync-server user remove alice --yes   # deletes everything of alice, for good
```

User names are 1 to 64 characters from `a-z 0-9 . _ -`, starting and ending with a letter or a
digit.

## Settings

Everything is set by environment variables (in `docker-compose.yml`). The defaults suit most
servers.

| Variable                         | Default                 | Meaning                                                       |
| -------------------------------- | ----------------------- | ------------------------------------------------------------- |
| `AMBY_SYNC_PUBLIC_URL`           | `http://localhost:8080` | the address users type; must be `https://` unless it is local |
| `AMBY_SYNC_ALLOW_HTTP`           | `0`                     | `1` allows plain `http://` on a trusted local network         |
| `AMBY_SYNC_TRUST_PROXY`          | `0`                     | `1` when a proxy such as Caddy sets `X-Forwarded-For`         |
| `AMBY_SYNC_QUOTA_BYTES_PER_USER` | off                     | most encrypted bytes one user may keep                        |
| `AMBY_SYNC_MAX_BLOB_BYTES`       | `536870912` (512 MiB)   | biggest single file after encryption                          |
| `AMBY_SYNC_PLANS_FILE`           | `<data dir>/plans.json` | the plans file (see "Plans and limits"); no file, no plans    |
| `AMBY_SYNC_RETAIN_VERSION_DAYS`  | `30`                    | how long old versions and deleted files stay restorable       |
| `AMBY_SYNC_ORPHAN_BLOB_HOURS`    | `24`                    | how long an upload nobody finished or committed is kept       |
| `AMBY_SYNC_DATA_DIR`             | `/data`                 | database and files (the Docker volume)                        |
| `AMBY_SYNC_LISTEN`               | `0.0.0.0:8080`          | address inside the container                                  |

A value the server cannot use stops it from starting, with a message that names the variable.
The rest of the limits (login attempts, request sizes) are visible at `/v1/info`.

Old versions and deleted files are removed by a cleanup that runs every ten minutes and before the
server stops; you can also run it by hand with `amby-sync-server maintenance`.

## Plans and limits

By default a user has no limits except the two ceilings above (`AMBY_SYNC_MAX_BLOB_BYTES`,
`AMBY_SYNC_QUOTA_BYTES_PER_USER`). To give users different limits, write a **plans file**
(`/data/plans.json`, or the path in `AMBY_SYNC_PLANS_FILE`). Without the file the server behaves
exactly as before. Numbers are whole bytes (decimal: 1 GB = 1000000000) or days, at least 1; every
limit is optional (a missing one means "no limit"):

```json
{
  "default_plan": "standard",
  "plans": {
    "standard": {
      "title": "Standard",
      "max_spaces": 1,
      "max_total_bytes": 1000000000,
      "max_file_bytes": 20000000,
      "history_days": 30,
      "max_history_bytes": 1000000000
    },
    "unlimited": { "title": "No limits" }
  }
}
```

A plan name is `a-z 0-9 _ -`, up to 32 characters. The file is read when the server starts; a typo
(unknown field, zero, repeated name, unknown `default_plan`) stops the start with a message, and so
does a user pinned to a plan the file no longer has. Check a file before restarting:
`amby-sync-server plans check [file]`. Where a ceiling and a plan both apply, the smaller wins.
`max_total_bytes` counts the latest versions of files and uploads waiting for their commit; old
versions and deleted files are the "history", shown apart. **A limit never deletes anything**: over
the quota the user can still delete, rename and shrink files, and a lowered plan leaves what is
there. The one exception is `max_history_bytes`: when the history is bigger, the cleanup removes the
oldest old versions first, never a latest version.

| Command                                      | What it does                                             |
| -------------------------------------------- | -------------------------------------------------------- |
| `user add <name> [--plan <plan>]`            | creates a user, pinned to a plan if given                |
| `user plan set <name> <plan>` / `--default`  | pins a plan / returns the user to the default plan       |
| `user plan show <name> [--json]`             | plan, limits and usage of a user                         |
| `user list [--json]`                         | users with their plan and the bytes they use             |
| `plans list [--json]` / `plans check [file]` | plans with their users / checks a file and pinned users  |
| `space list <name> [--json]`                 | spaces of a user with live and history bytes (no names)  |
| `space remove <name> <space_id> --yes`       | **deletes a space for good** with its versions and files |

A plan change applies at once, without a restart. **Make a `backup` before `space remove`.**

## Back up

Everything lives in one volume. The consistent way, while the server is running:

```bash
docker compose exec amby-sync amby-sync-server backup /data/backups/2026-10-20
docker cp "$(docker compose ps -q amby-sync)":/data/backups/2026-10-20 ./amby-backup-2026-10-20
docker compose exec amby-sync rm -r /data/backups/2026-10-20
```

The copy holds the database and the encrypted files; they are as unreadable as the live ones. To
restore, stop the server, **delete `amby-sync.db-wal` and `amby-sync.db-shm` from the volume if
they are there** (they belong to the database you are replacing, and SQLite would apply them to the
restored one), put `amby-sync.db` and `blobs/` back into the volume, and start it. A restored
server keeps its `instance_id` but is older than what your devices have seen; they notice that it
went back in time and do not delete anything to match it.
Keep a copy somewhere other than this machine, and remember that **every device also holds a full
copy of your notes**.

## Update

```bash
cd amby-notes && git pull
cd sync/server && docker compose up -d --build
```

The database updates itself on the first start of the new version. Make a backup first. A server
refuses to open a database written by a newer version, so rolling back needs the backup.

Version 0.2.0 moves the database from schema 1 to 2 (plans). Before it changes anything the server
copies the database to `<data dir>/backups/pre-v2-<ms>.db`, checks the copy, and records the move in
the table `meta` (`last_migration`). **To roll back:** stop the server, put that copy in place of
`amby-sync.db` (delete `amby-sync.db-wal` and `amby-sync.db-shm`), start the previous image. What
was committed after the move is lost, so do it only while there is no new data; plan assignments
are lost too, which only means "no limits".

## Good to know

- **Health check.** The container is checked through `/v1/info`; `docker compose ps` shows it as
  healthy.
- **Logs.** `docker compose logs amby-sync`. The log never contains tokens, keys, enrolment codes
  or request bodies.
- **A reset server announces itself.** The server gets a new random `instance_id` when its data
  directory is empty, so a device that sees a different one stops instead of deleting its files
  to match an empty server.
- **No Docker.** `cargo build --release -p amby-sync-server` (Rust 1.85 or newer) gives one
  binary; set the variables above and run `amby-sync-server serve` behind your own HTTPS proxy.

The server is licensed under AGPL-3.0-only.
