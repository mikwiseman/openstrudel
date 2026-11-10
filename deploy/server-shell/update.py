#!/usr/bin/env python3
"""Update the OpenStrudel Home on this server to the latest main of its repository.

  openstrudel-update

Builds the image from a fresh checkout and proves it loads. Then keeps a checked copy of the database, waits until
no chat is working and no schedule is about to run, switches the Home's Compose service to the new image and checks
it. If the new Home does not come up healthy with its data intact, the previous image is started again. Nothing
else on the server is touched. Run as root; the Home's owner runs it from their chat through the server shell.
"""
import argparse, datetime, fcntl, json, pathlib, os, shutil, sqlite3, stat, subprocess, sys, time

REPOSITORY = 'https://github.com/mikwiseman/openstrudel.git'
BRANCH = 'main'
SOURCE = pathlib.Path('/var/lib/openstrudel-update/source')   # the checkout the image is built from
BACKUPS = pathlib.Path('/var/backups/openstrudel-update')     # database copies and receipts; the newest three stay
LOCK = pathlib.Path('/root/openstrudel-management-deploy.lock')  # one update or manual deploy of a Home at a time
TABLES = ['employee_profiles', 'conversations', 'messages', 'schedules', 'schedule_runs', 'settings']
HEALTH = '''import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync('/data/.data/LocalConnection.json','utf8'));const r=await fetch(c.url+'/health',{headers:{authorization:'Bearer '+c.token},signal:AbortSignal.timeout(10000)});const h=await r.json();if(!r.ok||!h.ok)process.exit(1);console.log(JSON.stringify({ok:h.ok,telegram:h.telegram?.running===true}));'''


class Refused(Exception):
    """Nothing was changed."""


def say(text):
    try:
        print(text, flush=True)
    except OSError:  # whoever started the update is gone; it still finishes and leaves its receipt
        pass


def run(*args, timeout=120, cwd=None):
    done = subprocess.run(args, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    if done.returncode:
        raise RuntimeError(f"{' '.join(args[:3])} failed: {(done.stderr or done.stdout).strip()[-1500:]}")
    return done.stdout


def inspect(container):
    return json.loads(run('docker', 'inspect', container))[0]


def image(name, field):
    return json.loads(run('docker', 'image', 'inspect', '--format', '{{json .' + field + '}}', name))


def read(path):
    return sqlite3.connect(f'file:{path}?mode=ro', uri=True)


def counts(db):
    present = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    return {t: db.execute('SELECT COUNT(*) FROM ' + t).fetchone()[0] for t in TABLES if t in present}


def backup_database(source, target):
    """A consistent copy of the live database with SQLite's online backup, checked."""
    src, dst = read(source), sqlite3.connect(target)
    try:
        src.backup(dst)
        if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise Refused('The copy of the database failed its integrity check.')
        found = counts(dst)
    finally:
        dst.close()
        src.close()
    os.chmod(target, 0o600)
    return found


def working(path):
    """Requests still queued or running, and enabled schedules that fall due from two minutes ago to three ahead."""
    now = datetime.datetime.now(datetime.timezone.utc)
    low, high = ((now + datetime.timedelta(minutes=m)).isoformat()[:19] for m in (-2, 3))
    db = read(path)
    try:
        busy = db.execute("SELECT COUNT(*) FROM messages WHERE status IN ('queued','running')").fetchone()[0]
        due = db.execute("SELECT COUNT(*) FROM schedules WHERE enabled=1 AND substr(next_run_at,1,19) BETWEEN ? AND ?", (low, high)).fetchone()[0]
    finally:
        db.close()
    return busy, due


def wait_quiet(path, minutes=30):
    """The restart never cuts a reply short and never lands on a schedule."""
    deadline, told = time.monotonic() + minutes * 60, 0.0
    while True:
        busy, due = working(path)
        if not busy and not due:
            return
        if time.monotonic() > deadline:
            raise Refused(f'The Home stayed busy for {minutes} minutes ({busy} requests running, {due} schedules due).')
        if time.monotonic() - told > 60:
            say(f'waiting for the Home to be idle: {busy} requests running, {due} schedules due')
            told = time.monotonic()
        time.sleep(5)


def health(container):
    for _ in range(60):
        try:
            return json.loads(run('docker', 'exec', container, 'node', '--input-type=module', '-e', HEALTH, timeout=15))
        except Exception:
            time.sleep(2)
    raise RuntimeError('the Home did not report health ok')


def write_whole(path, text):
    """Replace a file in one rename, with its owner and mode."""
    info, temporary = path.stat(), path.with_name('.' + path.name + '.update')
    temporary.write_text(text)
    os.chown(temporary, info.st_uid, info.st_gid)
    os.chmod(temporary, stat.S_IMODE(info.st_mode))
    os.replace(temporary, path)


def checkout():
    """The latest main, exactly as published: a shallow fetch into a checkout this script owns."""
    if not (SOURCE / '.git').is_dir():
        SOURCE.mkdir(parents=True, exist_ok=True)
        run('git', 'init', '--quiet', str(SOURCE))
    git = lambda *args, **options: run('git', '-C', str(SOURCE), *args, **options).strip()
    git('fetch', '--quiet', '--depth', '1', REPOSITORY, BRANCH, timeout=600)
    git('checkout', '--quiet', '--force', '--detach', 'FETCH_HEAD')
    git('clean', '--quiet', '-fdx')
    return git('rev-parse', 'HEAD'), git('log', '-1', '--format=%s')


def update(container):
    held = open(LOCK, 'a')
    try:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise Refused(f'Another update or deploy holds {LOCK}.')
    before = inspect(container)
    labels, base, base_id = before['Config']['Labels'], before['Config']['Image'], before['Image']
    service, files = labels.get('com.docker.compose.service'), labels.get('com.docker.compose.project.config_files')
    if not service or not files:
        raise Refused(f'{container} was not started by Docker Compose.')
    compose_file = pathlib.Path(files.split(',')[0])
    compose = ['docker', 'compose', '--project-name', labels['com.docker.compose.project'], '--project-directory', labels['com.docker.compose.project.working_dir'],
               *(('--env-file', labels['com.docker.compose.project.environment_file']) if labels.get('com.docker.compose.project.environment_file') else ()),
               *(part for file in files.split(',') for part in ('-f', file))]
    up = lambda: run(*compose, 'up', '-d', '--no-build', service, timeout=300)
    database = next(pathlib.Path(m['Source']) for m in before['Mounts'] if m['Destination'] == '/data') / '.data/openstrudel.sqlite'
    was = health(container)  # the same check must pass before it is trusted afterwards

    commit, subject = checkout()
    target = f"{base.split(':')[0]}:main-{commit[:12]}"
    if base == target:
        say(f'Already on the latest main: {commit[:7]} "{subject}".')
        return
    for path in (BACKUPS.parent, '/var/lib/docker'):
        free = shutil.disk_usage(path).free
        if free < 12 * 1024 ** 3:
            raise Refused(f'Only {free / 1024 ** 3:.1f} GB free on {path}; an update needs 12 GB.')
    say(f'building {target} from {commit[:7]} "{subject}"')
    run('docker', 'build', '--quiet', '--label', 'org.opencontainers.image.revision=' + commit, '-t', target, str(SOURCE), timeout=3600)
    target_id = image(target, 'Id')
    if image(target, 'Config.User') != image(base, 'Config.User'):
        raise Refused('The new image runs as a different user.')
    run('docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node', target, '--input-type=module', '-e', "await import('/opt/openstrudel/dist/runtime.js')", timeout=120)
    text, old = compose_file.read_text(), f'    image: {base}\n'
    if text.count(old) != 1:
        raise Refused(f'{compose_file} does not name {base} exactly once.')

    backup = BACKUPS / (datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + commit[:7])
    backup.mkdir(mode=0o700, parents=True)
    (backup / 'container.json').write_text(json.dumps(before, indent=2))
    (backup / 'container.json').chmod(0o600)
    shutil.copy2(compose_file, backup / 'compose.yaml')
    wait_quiet(database)
    rows = backup_database(database, backup / 'openstrudel.sqlite')
    say(f'database copied to {backup}: integrity ok')
    wait_quiet(database)
    try:
        write_whole(compose_file, text.replace(old, f'    image: {target}\n'))
        say(f'starting the Home on {target}')
        up()
        now = health(container)
        current = inspect(container)
        if (current['Config']['Image'], current['Image']) != (target, target_id):
            raise RuntimeError(f"the Home runs {current['Config']['Image']}, not {target}")
        if was['telegram'] and not now['telegram']:
            raise RuntimeError('Telegram did not start')
        db = read(database)
        try:
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('the live database failed its integrity check')
            after = counts(db)
        finally:
            db.close()
        lost = {t: (rows[t], after.get(t)) for t in rows if after.get(t, 0) < rows[t]}
        if lost:
            raise RuntimeError(f'rows disappeared: {lost}')
    except BaseException as error:
        say(f'the new version failed ({error}); starting {base} again')
        try:
            write_whole(compose_file, (backup / 'compose.yaml').read_text())
            up()
            health(container)
        except Exception as again:
            raise RuntimeError(f'Update to {commit[:7]} failed: {error}. Starting {base} again failed too: {again}. The Home needs attention; the database copy is in {backup}.')
        raise RuntimeError(f'Update to {commit[:7]} failed: {error}. The Home is back on {base}; the database copy is in {backup}.')
    receipt = {'ok': True, 'commit': commit, 'subject': subject, 'image': target, 'imageId': target_id, 'previousImage': base, 'previousImageId': base_id,
               'backup': str(backup), 'rowsBefore': rows, 'rowsAfter': after, 'health': now, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')}
    (backup / 'receipt.json').write_text(json.dumps(receipt, indent=2))
    (backup / 'receipt.json').chmod(0o600)
    # What only this script made: its older database copies, and its images other than this one and the one before it.
    for old_backup in sorted(path for path in BACKUPS.iterdir() if path.is_dir())[:-3]:
        shutil.rmtree(old_backup)
    for tag in run('docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', base.split(':')[0]).split():
        if ':main-' in tag and tag not in (target, base):
            subprocess.run(['docker', 'image', 'rm', tag], capture_output=True)
    say(f'Updated to {commit[:7]} "{subject}". The Home is healthy on {target}; the previous image {base} stays for a rollback.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--container', default='openstrudel-home-1', help='the Home container on this server')
    try:
        update(parser.parse_args().container)
    except Refused as refusal:
        say(f'Not updated, nothing changed: {refusal}')
        sys.exit(2)
    except Exception as error:
        say(str(error) if str(error).startswith('Update to') else f'Not updated: {error}')
        sys.exit(1)
