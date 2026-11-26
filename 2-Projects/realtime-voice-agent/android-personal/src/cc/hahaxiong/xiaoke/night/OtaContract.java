package cc.hahaxiong.xiaoke.night;

/**
 * 固定更新契约。全部为编译期常量，运行期没有任何入口可以改写。
 *
 * 只信任一个源：https://pa.hahaxiong.cc:8666/mobile/night/latest.json，
 * 以及同源同目录下的 APK；固定包名，禁止重定向。
 */
final class OtaContract {
    static final String PACKAGE = "cc.hahaxiong.xiaoke.night";

    static final String HOST = "pa.hahaxiong.cc";
    static final int PORT = 8666;
    static final String ORIGIN = "https://pa.hahaxiong.cc:8666";
    static final String NIGHT_PATH = "/mobile/night/";
    static final String MANIFEST_URL = ORIGIN + NIGHT_PATH + "latest.json";
    /** APK 只接受该目录下、纯 ASCII 文件名的 .apk。 */
    static final String APK_PATH_REGEX = "/mobile/night/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.apk";

    static final int JOB_ID = 11260;
    static final long PERIOD_MS = 6L * 60L * 60L * 1000L;      // 持久定期检查
    static final long FOREGROUND_GAP_MS = 10L * 60L * 1000L;   // 启动自动检查节流
    static final long INSTALL_GAP_MS = 3L * 60L * 1000L;       // 用户点击安装的手势有效期

    static final long MAX_APK_BYTES = 256L * 1024L * 1024L;    // 单包体积上限
    static final int MAX_MANIFEST_BYTES = 64 * 1024;
    static final int MAX_VERSION_NAME = 64;
    static final int MAX_URL = 512;
    static final int MAX_STATE_BYTES = 4096;

    static final int CONNECT_MS = 10_000;
    static final int READ_MS = 20_000;
    static final int BUFFER = 64 * 1024;
    static final int ATTEMPTS = 3;
    static final long HEADROOM_BYTES = 8L * 1024L * 1024L;     // 下载前预留空间

    private OtaContract() {}
}
