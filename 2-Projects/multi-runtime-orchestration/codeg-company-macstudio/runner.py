#!/usr/bin/python3
# Deployed root-owned; read the one dedicated Keychain item, then drop privileges.
import ctypes
import logging
import logging.handlers
import os
import pwd
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path

USER = 'fu-121'
PROJECT = Path('/Users/fu-121/mycc/2-Projects/multi-runtime-orchestration/codeg-company-macstudio')
DATA = Path('/Users/fu-121/Library/Application Support/Codeg-company-studio')
PYTHON = '/Library/Developer/CommandLineTools/usr/bin/python3'


def credential():
    if os.getuid() != 0 or os.geteuid() != 0:
        raise RuntimeError('System launcher must start as root')
    library = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
    library.SecKeychainSetUserInteractionAllowed.argtypes = [ctypes.c_bool]
    library.SecKeychainSetUserInteractionAllowed.restype = ctypes.c_int32
    library.SecKeychainSetUserInteractionAllowed(False)
    library.SecKeychainOpen.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    library.SecKeychainOpen.restype = ctypes.c_int32
    keychain = ctypes.c_void_p()
    if library.SecKeychainOpen(b'/Library/Keychains/System.keychain', ctypes.byref(keychain)):
        raise RuntimeError('System Keychain unavailable')
    library.SecKeychainFindGenericPassword.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    library.SecKeychainFindGenericPassword.restype = ctypes.c_int32
    library.SecKeychainItemFreeContent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    library.SecKeychainItemFreeContent.restype = ctypes.c_int32
    library.CFRelease.argtypes = [ctypes.c_void_p]
    service, account = b'codeg.company-macstudio.server', b'fu-121'
    size, buffer = ctypes.c_uint32(), ctypes.c_void_p()
    status = library.SecKeychainFindGenericPassword(keychain, len(service), service, len(account), account, ctypes.byref(size), ctypes.byref(buffer), None)
    if status:
        raise RuntimeError('Dedicated Codeg Keychain credential unavailable: ' + str(status))
    try:
        value = ctypes.string_at(buffer, size.value).decode('ascii')
        if len(value) < 32:
            raise RuntimeError('Invalid Codeg credential')
        return value
    finally:
        library.SecKeychainItemFreeContent(None, buffer)
        library.CFRelease(keychain)


def run():
    token = credential()
    user = pwd.getpwnam(USER)
    os.umask(0o077)
    os.initgroups(USER, user.pw_gid)
    os.setgid(user.pw_gid)
    os.setuid(user.pw_uid)
    if os.getuid() != 501 or os.geteuid() != 501 or os.getgid() != user.pw_gid or os.getegid() != user.pw_gid:
        raise RuntimeError('Privilege drop failed')
    os.chdir(PROJECT)
    environment = {
        'HOME': user.pw_dir, 'USER': USER, 'LOGNAME': USER,
        'PATH': '/Users/fu-121/.local/bin:/Users/fu-121/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        'LANG': 'en_US.UTF-8', 'LC_CTYPE': 'UTF-8',
        'TMPDIR': '/tmp',
        'CODEG_HOST': '0.0.0.0', 'CODEG_PORT': '3080',
        'CODEG_HOME': str(DATA), 'CODEG_DATA_DIR': str(DATA),
        'CODEG_STATIC_DIR': str(PROJECT / 'releases/current/web'), 'CODEG_TOKEN': token,
        'http_proxy': 'http://127.0.0.1:10808', 'https_proxy': 'http://127.0.0.1:10808',
        'HTTP_PROXY': 'http://127.0.0.1:10808', 'HTTPS_PROXY': 'http://127.0.0.1:10808',
        'ALL_PROXY': 'socks5://127.0.0.1:10808', 'all_proxy': 'socks5://127.0.0.1:10808',
        'NO_PROXY': 'localhost,127.0.0.1,::1,.local,10.10.10.12,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,fc00::/7,fe80::/10', 'no_proxy': 'localhost,127.0.0.1,::1,.local,10.10.10.12,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,fc00::/7,fe80::/10',
    }
    log_dir = DATA / 'logs'
    log_dir.mkdir(mode=0o700, exist_ok=True)
    os.chmod(log_dir, 0o700)
    for logfile in log_dir.glob('service.log*'):
        if logfile.is_symlink():
            raise RuntimeError('Unexpected log symlink')
        os.chmod(logfile, 0o600)
    logger = logging.getLogger('codeg-company-studio')
    logger.setLevel(logging.INFO)
    handler = logging.handlers.RotatingFileHandler(log_dir / 'service.log', maxBytes=5*1024*1024, backupCount=3, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
    logger.addHandler(handler)

    def log(raw):
        cleaned = raw.replace(token.encode('ascii'), b'[redacted]')
        logger.info(cleaned.decode('utf-8', errors='replace').rstrip())

    server = None
    awake = None
    selector = None
    stopping = False

    def stop(signum, frame):
        nonlocal stopping
        stopping = True
        if server is not None:
            try:
                server.terminate()
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    pending = b''
    stop_started = None
    exited_at = None
    try:
        if stopping:
            return 0
        server = subprocess.Popen([str(PROJECT / 'releases/current/codeg-server'), '--supervise'], env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        # Keep children in launchd's process group so a killed launcher cannot leave listeners.
        # A signal can arrive inside Popen before the child is assigned above.
        # Forward a stop recorded in that window before starting more children.
        if stopping:
            stop(signal.SIGTERM, None)
        else:
            awake = subprocess.Popen(['/usr/bin/caffeinate', '-is', '-w', str(os.getpid())], env={k:v for k,v in environment.items() if k!='CODEG_TOKEN'}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        logger.info('launcher uid=%s pid=%s supervisor_pid=%s', os.getuid(), os.getpid(), server.pid)
        selector = selectors.DefaultSelector()
        selector.register(server.stdout, selectors.EVENT_READ)
        while True:
            if server.poll() is not None and exited_at is None:
                exited_at = time.monotonic()
                try:
                    server.terminate()
                except ProcessLookupError:
                    pass
            if exited_at is not None and time.monotonic()-exited_at > 2:
                break
            if stopping and stop_started is None:
                stop_started = time.monotonic()
            if stop_started is not None and time.monotonic()-stop_started > 12:
                try:
                    server.kill()
                except ProcessLookupError:
                    pass
                break
            for key, _ in selector.select(timeout=1):
                chunk = os.read(key.fileobj.fileno(), 16384)
                if not chunk:
                    selector.unregister(key.fileobj)
                    break
                pending += chunk
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    log(line)
                if len(pending) > 65536:
                    # Preserve overlap so tokens split across chunks stay hidden.
                    cut = len(pending)-len(token)
                    cleaned = pending.replace(token.encode('ascii'), b'[redacted]')
                    if cleaned != pending:
                        pending = cleaned
                        cut = len(pending)-len(token)
                    log(pending[:cut])
                    pending = pending[cut:]
            if server.poll() is not None and not selector.get_map():
                break
        if pending:
            log(pending)
        status = server.wait(timeout=15)
        logger.info('supervisor exited status=%s; launchd will restart unless unloaded', status)
        return status if status >= 0 else 128-status
    finally:
        if selector is not None:
            selector.close()
        if server is not None:
            try:
                server.terminate()
            except ProcessLookupError:
                pass
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    server.kill()
                except ProcessLookupError:
                    pass
                server.wait(timeout=5)
            if server.stdout is not None:
                server.stdout.close()
        if awake is not None:
            awake.terminate()
            try:
                awake.wait(timeout=5)
            except subprocess.TimeoutExpired:
                awake.kill()
                awake.wait(timeout=5)
        handler.close()


if __name__ == '__main__':
    try:
        sys.exit(run())
    except Exception as error:
        # Never include credential values or raw child output in launchd logs.
        sys.stderr.write('Codeg launcher failure: '+type(error).__name__+'\n')
        sys.exit(1)
