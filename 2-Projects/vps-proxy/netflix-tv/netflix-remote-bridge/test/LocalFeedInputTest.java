package cn.hahaxiong.netflixremote;

import java.io.File;
import java.nio.file.Files;
import java.util.concurrent.TimeUnit;

public final class LocalFeedInputTest {
    private static int checks;
    private static void check(boolean value,String why){checks++;if(!value)throw new AssertionError(why);}
    private static int shell(String command)throws Exception{Process p=new ProcessBuilder("/bin/sh","-c",command).redirectErrorStream(true).start();if(!p.waitFor(2,TimeUnit.SECONDS)){p.destroyForcibly();throw new AssertionError("guard hung");}return p.exitValue();}
    public static void main(String[] args)throws Exception{
        FeedPolicy.Scene scene=FeedPolicy.detect(FeedPolicyTest.fixture("feed-before.txt"),new NavCore.Box(0,0,3840,2160),344,false);
        FeedPolicy.Gesture swipe=FeedPolicy.gesture(scene,NavCore.DOWN);
        File directory=Files.createTempDirectory("netflix-feed-command-").toFile();File permit=new File(directory,"permit'with-space");
        try{
            String cmd=LocalFeedInput.command(permit,swipe,2147483647,4102444800L);
            check(cmd.endsWith("exec /system/bin/input touchscreen swipe 1920 1747 1920 622 420"),"real viewport converted to absolute input path and only integer swipe arguments");
            check(cmd.contains("test -d /proc/2147483647"),"dead app process blocks delayed privileged execution");
            check(cmd.contains("test \"$(/system/bin/date +%s)\" -le 4102444800"),"independent lease expires even if app cleanup cannot run");
            check(shell(cmd)==1,"missing intent token stops before privileged input execution");
            check(permit.createNewFile(),"real permit created");
            check(shell(cmd)==1,"dead owner blocks execution even with a real token");
            check(permit.delete()&&shell(cmd)==1,"cancelled token never executes later");
            boolean invalid=false;try{LocalFeedInput.command(permit,swipe,0,1);}catch(IllegalArgumentException expected){invalid=true;}
            check(invalid,"invalid owner rejected");
            invalid=false;try{LocalFeedInput.command(permit,null,1,1);}catch(IllegalArgumentException expected){invalid=true;}
            check(invalid,"unknown gesture rejected");
            LocalFeedInput fallback=new LocalFeedInput();fallback.cancel();check(!fallback.busy()&&!fallback.rootVerified(),"cancel/initialization never implicitly grants root");
        }finally{permit.delete();directory.delete();}
        System.out.println("PASS: "+checks+" local feed command/lease regressions (real viewport, actual shell negative guards; no su/device operation)");
    }
}
