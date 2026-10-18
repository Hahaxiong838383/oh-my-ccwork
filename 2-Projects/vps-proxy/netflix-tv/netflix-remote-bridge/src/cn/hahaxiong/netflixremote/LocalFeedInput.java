package cn.hahaxiong.netflixremote;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/** Narrow local fallback: only a bounded, integer-coordinate feed swipe; never an arbitrary command. */
public final class LocalFeedInput {
    public interface Callback {void finished(boolean success,String reason);}
    private final Object lock=new Object();
    private int task;private File token;private Process process;
    private volatile boolean rootVerified,busy;
    private volatile String lastResult="not_used";
    public boolean rootVerified(){return rootVerified;}
    public boolean busy(){return busy;}
    public String lastResult(){return lastResult;}
    public void cancel(){
        synchronized(lock){task++;if(token!=null)token.delete();token=null;if(process!=null)process.destroyForcibly();process=null;busy=false;}
    }
    public void start(File cache,FeedPolicy.Gesture gesture,int ownerPid,Callback callback){
        final int ticket;final File permit;
        synchronized(lock){
            if(busy){callback.finished(false,"busy");return;}
            ticket=++task;permit=new File(cache,"feed-swipe-intent-"+ticket+"-"+System.nanoTime());
            try{if(!permit.createNewFile())throw new IOException("exists");}catch(IOException error){callback.finished(false,"token_failed");return;}
            token=permit;busy=true;
        }
        new Thread(()->{
            boolean success=false;String reason="cancelled";
            try{
                // This read-only probe runs under the application's actual UID/SELinux context.
                if(!rootVerified){
                    Result probe=run(ticket,permit,"/system/bin/id -u",1200);
                    rootVerified=probe.exit==0&&"0".equals(probe.output.trim());
                    if(!rootVerified){reason=probe.timedOut?"root_probe_timeout":"root_not_authorized";return;}
                }
                if(!current(ticket,permit))return;
                Result result=run(ticket,permit,command(permit,gesture,ownerPid,System.currentTimeMillis()/1000+3),2200);
                success=result.exit==0&&!result.timedOut;reason=result.timedOut?"input_timeout":"input_exit_"+result.exit;
            }catch(Exception error){reason=error.getClass().getSimpleName();}
            finally{
                permit.delete();
                synchronized(lock){if(ticket==task){busy=false;token=null;process=null;lastResult=reason;}}
                callback.finished(success,reason);
            }
        },"NetflixFeedInput").start();
    }
    private boolean current(int ticket,File permit){synchronized(lock){return ticket==task&&permit.exists();}}
    private Result run(int ticket,File permit,String command,long timeoutMs)throws Exception{
        final Process child;
        synchronized(lock){
            if(ticket!=task||!permit.exists())return new Result(-1,false,"");
            child=new ProcessBuilder("/system/bin/su","-c",command).redirectErrorStream(true).start();process=child;
        }
        boolean finished=child.waitFor(timeoutMs,TimeUnit.MILLISECONDS);
        if(!finished){permit.delete();child.destroyForcibly();child.waitFor(200,TimeUnit.MILLISECONDS);return new Result(-1,true,"");}
        byte[] output=new byte[128];int length=child.getInputStream().read(output);
        return new Result(child.exitValue(),false,length<0?"":new String(output,0,length,StandardCharsets.UTF_8));
    }
    private static final class Result {final int exit;final boolean timedOut;final String output;Result(int exit,boolean timedOut,String output){this.exit=exit;this.timedOut=timedOut;this.output=output;}}
    /** The permit is deleted on new input/window changes, preventing a delayed su grant from executing. */
    static String command(File permit,FeedPolicy.Gesture gesture,int ownerPid,long deadlineSeconds){
        if(ownerPid<=0||deadlineSeconds<=0||gesture==null||!Float.isFinite(gesture.x)||!Float.isFinite(gesture.startY)||!Float.isFinite(gesture.endY)||gesture.x<0||gesture.startY<0||gesture.endY<0||gesture.durationMs<100||gesture.durationMs>1500)throw new IllegalArgumentException("invalid gesture");
        int x=Math.round(gesture.x),start=Math.round(gesture.startY),end=Math.round(gesture.endY);
        String path="'"+permit.getAbsolutePath().replace("'","'\\''")+"'";
        return "test -f "+path+" && test -d /proc/"+ownerPid+" && test \"$(/system/bin/date +%s)\" -le "+deadlineSeconds+" && exec /system/bin/input touchscreen swipe "+x+" "+start+" "+x+" "+end+" "+gesture.durationMs;
    }
}
