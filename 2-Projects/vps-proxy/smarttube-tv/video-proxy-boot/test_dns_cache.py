#!/usr/bin/env python3
"""Exercise the production Java reflection against an isolated Binder-shaped API.

No ADB, real Android service, broadcast, or cache is accessed. Device validation
must separately prove the installed platform exposes and executes this API.
"""
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
JAVA_BIN = Path('/home/hahaxiong83/.local/share/codeg-android-toolchain/jdk-21/bin')
STUBS = {
    'android/os/IBinder.java': '''package android.os;
public interface IBinder {}''',
    'android/os/ServiceManager.java': '''package android.os;
public final class ServiceManager {
  public static IBinder getService(String name) {
    System.out.println("SERVICE " + name);
    return Boolean.getBoolean("missingService") ? null : new IBinder() {};
  }
}''',
    'android/net/IDnsResolver.java': '''package android.net;
import android.os.IBinder;
public interface IDnsResolver {
  void flushNetworkCache(int networkId);
  public static final class Stub {
    public static IDnsResolver asInterface(IBinder binder) {
      if (Boolean.getBoolean("missingResolver")) return null;
      return new IDnsResolver() {
        public void flushNetworkCache(int networkId) {
          System.out.println("FLUSH " + networkId);
          if (Integer.getInteger("failId", -1) == networkId)
            throw new IllegalStateException("private failure detail must not escape");
        }
      };
    }
  }
}''',
}


def main():
    count = 0

    def check(condition, message):
        nonlocal count
        if not condition:
            raise AssertionError(message)
        count += 1
        print('PASS ' + message)

    with tempfile.TemporaryDirectory(prefix='video-dns-java-tests-') as root:
        tmp = Path(root)
        files = [HERE / 'VideoDnsCache.java']
        for name, source in STUBS.items():
            target = tmp / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(source)
            files.append(target)
        subprocess.run([str(JAVA_BIN / 'javac'), '--release', '8', '-Xlint:all,-options',
                        '-Werror', '-d', str(tmp), *map(str, files)], check=True)

        def run(args, props=()):
            return subprocess.run([str(JAVA_BIN / 'java'), *props, '-cp', str(tmp),
                                   'VideoDnsCache', *args], text=True, capture_output=True,
                                  timeout=5)

        result = run(['107', '235', '4096'])
        check(result.returncode == 0, 'reflection resolves platform Stub and flush method')
        check([line for line in result.stdout.splitlines() if line.startswith('FLUSH ')] ==
              ['FLUSH 107', 'FLUSH 235', 'FLUSH 4096'],
              'each requested runtime network ID reaches the actual fake service method')
        check(result.stdout.count('dns_cache_flushed netId=') == 3,
              'successful service invocations produce per-network evidence')
        for args in [[], ['0'], ['-1'], ['65536'], ['99999999999999999999'],
                     ['101;reboot'], ['01'], ['107', 'bad']]:
            result = run(args)
            check(result.returncode == 2 and not result.stdout,
                  'invalid request fails before any service call: ' + repr(args))
        result = run(['1', '65535'])
        check(result.returncode == 0 and 'FLUSH 65535' in result.stdout,
              'valid positive 16-bit network ID boundaries are accepted')
        for prop in ['-DmissingService=true', '-DmissingResolver=true']:
            result = run(['107'], [prop])
            check(result.returncode == 1 and 'FLUSH ' not in result.stdout,
                  'missing Binder endpoint/interface fails closed: ' + prop)
        result = run(['107', '235', '4096'], ['-DfailId=235'])
        check(result.returncode == 1 and 'FLUSH 4096' not in result.stdout,
              'platform exception prevents later success and propagates failure')
        check('java.lang.IllegalStateException' in result.stderr and
              'private failure detail' not in result.stderr,
              'reflective platform error identifies cause type without exposing its detail')
        # Separately compile the same helper alone: missing services.jar is a
        # real missing-class failure, not a fake service returning an error.
        alone = tmp / 'alone'
        alone.mkdir()
        subprocess.run([str(JAVA_BIN / 'javac'), '--release', '8', '-Xlint:all,-options',
                        '-Werror', '-d', str(alone), str(HERE / 'VideoDnsCache.java')], check=True)
        result = subprocess.run([str(JAVA_BIN / 'java'), '-cp', str(alone),
                                 'VideoDnsCache', '107'], text=True, capture_output=True,
                                timeout=5)
        check(result.returncode == 1 and 'ClassNotFoundException' in result.stderr,
              'missing platform classpath is a failure, never a claimed flush')
        hosts = tmp / 'hosts'
        hosts.write_text('192.0.2.17 www.youtube.com\n192.0.2.23 ntp3.aliyun.com\n')
        for host, address in [('www.youtube.com', '192.0.2.17'), ('ntp3.aliyun.com', '192.0.2.23')]:
            result = run(['--resolve', host], ['-Djdk.net.hosts.file=' + str(hosts)])
            check(result.returncode == 0 and result.stdout.strip() ==
                  f'SYSTEM_DNS_OK host={host} address={address}',
                  'production InetAddress resolver returns fixture address for ' + host)
        hosts.write_text('192.0.2.23 ntp3.aliyun.com\n')
        result = run(['--resolve', 'www.youtube.com'], ['-Djdk.net.hosts.file=' + str(hosts)])
        check(result.returncode == 1 and not result.stdout and 'UnknownHostException' in result.stderr,
              'real InetAddress failure produces no success record and a failing exit status')
        for args in [['--resolve'], ['--resolve', 'www.youtube.com', 'extra'],
                     ['--resolve', 'example.com'], ['--resolve', 'www.youtube.com;reboot']]:
            result = run(args, ['-Djdk.net.hosts.file=' + str(hosts)])
            check(result.returncode == 2 and not result.stdout,
                  'invalid resolver arguments fail before any service or DNS success: ' + repr(args))
    print(f'PASS all {count} Java helper assertions; temporary files removed')


if __name__ == '__main__':
    main()
