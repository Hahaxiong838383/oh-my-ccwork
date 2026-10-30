package cn.hahaxiong.tvnetstatus;

/** Pure state machine: deadline begins only once the ready view was attached. */
public final class StatusModel {
    public static final long SUCCESS_MS = 2000, FRESH_MS = 3000;
    public String boot = "", phase = "connecting";
    public boolean home, ready, done;
    private long sequence = -1, received = -1, shown = -1;

    public boolean accept(String b, String p, boolean h, boolean r, long seq, long now) {
        if (done || b == null || !b.matches("[0-9a-f-]{36}") ||
                (!boot.isEmpty() && !boot.equals(b)) || seq <= sequence ||
                seq > now + 1000 || now - seq > FRESH_MS) return false;
        boot = b; phase = p; home = h; ready = r;
        sequence = seq; received = now;
        if (!r || !h) shown = -1;
        if (r && !h) done = true;
        return true;
    }
    public boolean visible(long now) {
        return !done && home && received >= 0 && now - received < FRESH_MS;
    }
    public boolean abandoned(long now) { return received >= 0 && now - received >= 15000; }
    public void attached(long now) { if (ready && shown < 0) shown = now; }
    public void tick(long now) {
        if (ready && shown >= 0 && now - shown >= SUCCESS_MS) done = true;
        // A lost source must never leave a window over another application.
        if (received >= 0 && now - received >= FRESH_MS) shown = -1;
    }
    public String title() {
        if (ready) return "网络已连接";
        if ("clock".equals(phase)) return "正在校准时间…";
        if ("proxy".equals(phase)) return "正在连接视频线路…";
        if ("dns".equals(phase)) return "正在检查网络…";
        if ("cache".equals(phase)) return "正在完成网络准备…";
        if ("retry".equals(phase)) return "正在重试连接…";
        return "正在连接网络…";
    }
}
