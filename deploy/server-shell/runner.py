#!/usr/bin/env python3
"""The owner's shell on the server that hosts an OpenStrudel Home.

A Home in its container cannot reach the server it runs on. Installed here as root (install.sh), this runner lets
the Home's owner run commands on the server from their own chat. The Home writes each command into the folder
.data/server-shell on its data volume; the runner executes it as root and writes the result back. The Home offers
this only to the Telegram users named at installation, in their private chat, and to the owner's devices in the app.

Whatever can write into the Home's data folder is root on this server. Install it only on the owner's own server.

  runner.py SPOOL        SPOOL is that folder as the server sees it
"""
import json, os, pathlib, re, signal, subprocess, sys, threading, time

ID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
KEEP = 100_000  # characters of output returned, from the end
LIMIT = 6 * 3600


def hand_over(path, text, owner):
    """Whole or not at all, and readable by the Home."""
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(text)
    os.chown(temporary, owner.st_uid, owner.st_gid)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def finish(spool, owner, request_id, result):
    hand_over(spool / 'results' / (request_id + '.json'), json.dumps(result), owner)
    (spool / 'running' / (request_id + '.json')).unlink(missing_ok=True)


def execute(spool, owner, request_id, command, timeout):
    started = time.monotonic()
    # Its own session: stopping it stops everything it started, and it outlives a restart of this runner.
    process = subprocess.Popen(['bash', '-lc', command], cwd=os.path.expanduser('~'), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    output, state = bytearray(), {'truncated': False}

    def read():
        for chunk in iter(lambda: process.stdout.read1(65536), b''):
            output.extend(chunk)
            if len(output) > 8 * KEEP:
                del output[:-4 * KEEP]
                state['truncated'] = True

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    timed_out = False
    try:
        process.wait(timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        for signal_number in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(process.pid, signal_number)
                process.wait(10)
                break
            except (ProcessLookupError, subprocess.TimeoutExpired):
                continue
    reader.join(2)  # a daemon the command left behind may hold the pipe open forever
    text = bytes(output).decode('utf-8', 'replace')
    result = {'exitCode': None if timed_out else process.returncode, 'output': text[-KEEP:], 'seconds': round(time.monotonic() - started, 1)}
    if state['truncated'] or len(text) > KEEP:
        result['truncated'] = True
    if timed_out:
        result['timedOut'] = True
    finish(spool, owner, request_id, result)


def take(spool, owner, path):
    request_id = path.name[:-len('.json')]
    if not ID.fullmatch(request_id) or path.is_symlink() or not path.is_file():
        path.unlink(missing_ok=True)
        return
    running = spool / 'running' / path.name
    try:
        os.replace(path, running)  # from here on it never runs a second time, whatever happens to this runner
    except FileNotFoundError:  # the Home withdrew it
        return
    try:
        request = json.loads(running.read_text())
        command, timeout = request['command'], request.get('timeoutSeconds', 600)
        assert isinstance(command, str) and command.strip() and isinstance(timeout, int) and 1 <= timeout <= LIMIT
    except Exception:
        finish(spool, owner, request_id, {'exitCode': None, 'output': 'The request could not be read. Nothing was run.', 'seconds': 0})
        return
    threading.Thread(target=execute, args=(spool, owner, request_id, command, timeout), daemon=True).start()


def main(spool):
    owner = spool.parent.stat()  # the Home's user owns its .data
    for folder in (spool, spool / 'requests', spool / 'running', spool / 'results'):
        folder.mkdir(mode=0o700, exist_ok=True)
        os.chown(folder, owner.st_uid, owner.st_gid)
    # A command that was running when the server or this runner restarted: it is not run again, and the Home is told.
    for left in (spool / 'running').glob('*.json'):
        finish(spool, owner, left.name[:-len('.json')], {'exitCode': None, 'interrupted': True, 'seconds': 0,
               'output': 'The server or its command runner restarted while this command ran. Its outcome is unknown; check before repeating it.'})
    beat = 0.0
    while True:
        try:
            if time.monotonic() - beat > 5:
                hand_over(spool / 'runner.json', json.dumps({'pid': os.getpid()}), owner)
                beat = time.monotonic()
            for path in sorted((spool / 'requests').glob('*.json')):
                take(spool, owner, path)
        except Exception as error:  # one bad request or a full disk must not stop the commands already running
            print(f'openstrudel-server-shell: {error!r}', file=sys.stderr, flush=True)
        time.sleep(0.5)


if __name__ == '__main__':
    if len(sys.argv) != 2 or not pathlib.Path(sys.argv[1]).parent.is_dir():
        raise SystemExit(__doc__)
    main(pathlib.Path(sys.argv[1]))
