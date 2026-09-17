#!/usr/bin/env python3
"""Install this project's inference and restricted SSH tunnel as user LaunchAgents."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--pi-host', required=True)
    parser.add_argument('--pi-user', default='pi')
    parser.add_argument('--node', default=shutil.which('node'))
    args = parser.parse_args()
    if os.uname().sysname != 'Darwin' or os.getuid() == 0:
        parser.error('Run as the signed-in macOS user, without sudo.')
    root, config = args.root.resolve(), args.config.absolute()
    node = Path(args.node or '').resolve()
    if not node.is_file() or not os.access(node, os.X_OK):
        parser.error('An executable Node.js runtime is required.')
    if not (root / 'scripts/start-private-model-server.ts').is_file():
        parser.error('Expected the AI Self project root.')
    for value in (args.pi_host, args.pi_user):
        if not value or value.startswith('-') or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-' for c in value):
            parser.error('Use a plain SSH hostname and username.')
    private = root / '.local/private-model'
    source_identity = private / 'ssh_ed25519'
    source_hosts = private / 'known_hosts'
    for path in (config, source_identity, source_hosts):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            parser.error(f'Expected a private, user-owned regular file: {path}')
    settings = json.loads(config.read_text())
    if settings.get('port') != 11441 or settings.get('upstream') != 'http://127.0.0.1:11440':
        parser.error('This installer requires dedicated Ollama port 11440 and gateway port 11441.')
    # Background ssh cannot depend on macOS Desktop privacy grants. Keep only
    # this project's tunnel credentials in the normal SSH configuration folder.
    ssh_dir = Path.home() / '.ssh'
    ssh_dir.mkdir(mode=0o700, exist_ok=True)
    identity = ssh_dir / 'ai_self_model_ed25519'
    known_hosts = ssh_dir / 'ai_self_model_known_hosts'
    for source, target in ((source_identity, identity), (source_hosts, known_hosts)):
        if target.exists() or target.is_symlink():
            info = target.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or target.read_bytes() != source.read_bytes():
                parser.error(f'Refusing to replace a different existing SSH file: {target}')
        else:
            with target.open('xb') as output:
                target.chmod(0o600)
                output.write(source.read_bytes())
        target.chmod(0o600)
    quoted_hosts = '"' + str(known_hosts).replace('\\', '\\\\').replace('"', '\\"') + '"'
    logs = private / 'logs'
    logs.mkdir(mode=0o700, parents=True, exist_ok=True)
    agents = Path.home() / 'Library/LaunchAgents'
    agents.mkdir(parents=True, exist_ok=True)
    jobs = [
        ('com.ai-self.model', {
            'ProgramArguments': [str(node), '--import', 'tsx', str(root / 'scripts/start-private-model-server.ts')],
            'EnvironmentVariables': {
                'PRIVATE_MODEL_CONFIG': str(config),
                'PATH': f'{node.parent}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
            },
        }),
        ('com.ai-self.model-tunnel', {
            'ProgramArguments': [
                '/usr/bin/ssh', '-F', '/dev/null', '-N', '-T',
                '-i', str(identity), '-o', 'IdentitiesOnly=yes',
                '-o', 'UserKnownHostsFile=' + quoted_hosts,
                '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes',
                '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
                '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
                '-R', '127.0.0.1:11441:127.0.0.1:11441',
                args.pi_user + '@' + args.pi_host,
            ],
        }),
    ]
    domain = f'gui/{os.getuid()}'
    for label, values in jobs:
        # Existing files belonging to other services are never touched.
        target = agents / (label + '.plist')
        values.update({
            'Label': label, 'WorkingDirectory': str(root),
            'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10,
            'ProcessType': 'Background', 'Umask': 0o077,
            'StandardOutPath': str(logs / (label + '.out.log')),
            'StandardErrorPath': str(logs / (label + '.err.log')),
        })
        pending = target.with_suffix('.plist.pending')
        with pending.open('wb') as output:
            plistlib.dump(values, output, sort_keys=False)
        pending.chmod(0o600)
        subprocess.run(['/usr/bin/plutil', '-lint', str(pending)], check=True)
        subprocess.run(['/bin/launchctl', 'bootout', domain + '/' + label], capture_output=True)
        for _ in range(40):
            removed = subprocess.run(['/bin/launchctl', 'print', domain + '/' + label], capture_output=True)
            if removed.returncode != 0:
                break
            time.sleep(0.25)
        else:
            raise RuntimeError(f'Timed out waiting for the previous {label} job to stop.')
        pending.replace(target)
        # launchd may finish removing a job asynchronously after print stops
        # finding it. Retry only this project's bounded bootstrap transition.
        for attempt in range(5):
            boot = subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(target)], capture_output=True)
            if boot.returncode == 0:
                break
            if attempt == 4:
                raise RuntimeError(f'Could not load {label}: ' + boot.stderr.decode(errors='replace').strip())
            time.sleep(1)
        print(f'Installed {label}; starts at user login and restarts after process failure.')
    print('This installs user services, not a pre-login daemon or power-on policy.')


if __name__ == '__main__':
    main()
