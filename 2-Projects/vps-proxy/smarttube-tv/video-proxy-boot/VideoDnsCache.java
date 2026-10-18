import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.InetAddress;

/** Invoked by app_process with this dex AND /system/framework/services.jar. */
public final class VideoDnsCache {
    private VideoDnsCache() {}

    public static void main(String[] args) {
        if (args.length > 0 && "--resolve".equals(args[0])) {
            if (args.length != 2 || !("www.youtube.com".equals(args[1])
                    || "ntp3.aliyun.com".equals(args[1]))) {
                System.err.println("system_dns_failed: invalid host arguments");
                System.exit(2);
            }
            try {
                InetAddress[] addresses = InetAddress.getAllByName(args[1]);
                if (addresses.length == 0) throw new IllegalStateException("no addresses");
                for (InetAddress address : addresses) {
                    System.out.println("SYSTEM_DNS_OK host=" + args[1]
                            + " address=" + address.getHostAddress());
                }
            } catch (Exception error) {
                System.err.println("system_dns_failed: " + error.getClass().getName());
                System.exit(1);
            }
            return;
        }
        // Validate the entire request before contacting the service: a malformed
        // later ID must not leave an earlier network partially changed.
        int[] networkIds = new int[args.length];
        if (args.length == 0) {
            System.err.println("dns_cache_flush_failed: expected network IDs");
            System.exit(2);
        }
        for (int i = 0; i < args.length; ++i) {
            if (!args[i].matches("[1-9][0-9]{0,4}")) {
                System.err.println("dns_cache_flush_failed: invalid network ID");
                System.exit(2);
            }
            networkIds[i] = Integer.parseInt(args[i]);
            if (networkIds[i] > 65535) {
                System.err.println("dns_cache_flush_failed: network ID out of range");
                System.exit(2);
            }
        }
        try {
            Class<?> binder = Class.forName("android.os.IBinder");
            Object service = Class.forName("android.os.ServiceManager")
                    .getMethod("getService", String.class).invoke(null, "dnsresolver");
            if (service == null) throw new IllegalStateException("dnsresolver unavailable");
            Object resolver = Class.forName("android.net.IDnsResolver$Stub")
                    .getMethod("asInterface", binder).invoke(null, service);
            if (resolver == null) throw new IllegalStateException("resolver unavailable");
            Method flush = Class.forName("android.net.IDnsResolver")
                    .getMethod("flushNetworkCache", int.class);
            for (int networkId : networkIds) {
                flush.invoke(resolver, networkId);
                System.out.println("dns_cache_flushed netId=" + networkId);
            }
        } catch (Exception error) {
            Throwable cause = error instanceof InvocationTargetException
                    ? ((InvocationTargetException) error).getTargetException() : error;
            System.err.println("dns_cache_flush_failed: " + cause.getClass().getName());
            System.exit(1);
        }
    }
}
