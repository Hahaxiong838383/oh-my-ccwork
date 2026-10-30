package cn.hahaxiong.tvnetstatus;

public final class StatusModelTest {
    private static final String BOOT="5221cafe-ca9c-4f1d-ad1d-4bf399d87d7c";
    static void check(boolean b, String why) { if (!b) throw new AssertionError(why); }
    public static void main(String[] args) {
        StatusModel s=new StatusModel();
        check(!s.visible(0),"no source, no window");
        check(s.accept(BOOT,"clock",true,false,1000,1000),"first current boot");
        check(s.visible(1000),"waiting is visible on home");
        check(!s.accept("00000000-0000-0000-0000-000000000000","ready",true,true,1100,1100),"reject different boot");
        check(!s.accept(BOOT,"ready",true,true,900,1200),"reject out of order");
        s.accept(BOOT,"retry",true,false,2000,2000);
        check(s.title().contains("重试"),"failure never success");
        s.accept(BOOT,"cache",false,false,2500,2500);
        check(!s.visible(2500),"hide during playback");
        s.accept(BOOT,"cache",true,false,3000,3000);
        check(s.visible(3000),"return home before ready");
        s.accept(BOOT,"ready",true,true,4000,4000);
        s.tick(9000); check(!s.done,"no timeout before view attached");
        s.accept(BOOT,"ready",true,true,9000,9000); s.attached(9100);
        s.accept(BOOT,"ready",true,true,10000,10000); s.attached(10000);
        s.tick(11099); check(!s.done,"visible for full 2 seconds");
        s.tick(11100); check(s.done && !s.visible(11100),"2s deadline, heartbeat does not extend");
        StatusModel lost=new StatusModel(); lost.accept(BOOT,"dns",true,false,1000,1000);
        check(!lost.visible(4000),"lost source fails closed");
        StatusModel outside=new StatusModel(); outside.accept(BOOT,"ready",false,true,1000,1000);
        check(outside.done && !outside.visible(1000),"ready in video exits without flash");
        StatusModel rollback=new StatusModel(); rollback.accept(BOOT,"ready",true,true,1000,1000); rollback.attached(1000);
        rollback.accept(BOOT,"retry",true,false,2000,2000); rollback.tick(3000);
        check(!rollback.done,"readiness revoked cancels success deadline");
        check(!new StatusModel().accept(BOOT,"ready",true,true,1000,5000),"stale source rejected");
        System.out.println("StatusModel: 16 behavior checks passed");
    }
}
