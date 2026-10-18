package cn.hahaxiong.netflixremote;
public class KeyStateTest {
    private static int checks;
    private static void check(boolean v,String why){checks++;if(!v)throw new AssertionError(why);}
    public static void main(String[] args){
        KeyState k=new KeyState();k.down(23,100,false);k.consume(23,100);long ticket=k.generation();
        check(k.hasPressed(120),"held OK waits");check(k.release(23),"release paired OK");check(k.current(ticket,140),"normal release preserves intent");
        k.down(22,145,false);k.consume(22,145);
        check(!k.current(ticket,150),"new DOWN during 50ms post-release delay cancels old click");
        long next=k.generation();k.clear();check(!k.hasPressed(200),"interrupt/scene clear removes held keys");check(!k.current(next,200),"clear cancels delayed intent");
        k.down(23,1000,false);k.consume(23,1000);long orphan=k.generation();check(!k.hasPressed(6101),"lost UP expires");check(!k.current(orphan,6101),"expired gesture is cancelled, never fired late");
        k.down(23,7000,false);k.consume(23,7000);k.down(23,11000,true);check(k.hasPressed(13000),"real long-press repeats refresh hold lifetime");
        k.clear();k.down(4,14000,false);k.consume(4,14000);check(k.owns(4,14010),"BACK cancel owns all repeat DOWNs until its UP");check(!k.owns(22,14010),"other keys retain their native ownership");k.release(4);check(!k.owns(4,14020),"next fresh BACK can exit normally");
        long nativeTicket=k.generation();k.down(4,15000,false);check(!k.current(nativeTicket,15010),"native BACK supersedes pending 50ms action even before window changes");check(!k.owns(4,15010),"invalidating native BACK does not consume its key pair");
        // Observed TV firmware: EV_KEY=2 may arrive with a reset downTime/repeatCount.
        // Without any UP, first-consumed time must survive every fresh-looking DOWN.
        k.clear();k.down(22,20000,false);k.consume(22,20000);
        check(k.heldDuration(22,20000)==0&&SeekPolicy.stepMs(k.heldDuration(22,20000))==10000,"first short press uses ten seconds");
        long beforeRepeat=k.generation();k.down(22,20750,false);k.consume(22,20750);
        check(k.heldDuration(22,20750)==750&&SeekPolicy.stepMs(k.heldDuration(22,20750))==30000,"reset firmware downTime/count still accelerates at 750ms");
        check(k.generation()==beforeRepeat+1,"hold tracking does not change existing intent generation semantics");
        k.down(22,22100,false);k.consume(22,22100);
        check(k.heldDuration(22,22100)==2100&&SeekPolicy.stepMs(k.heldDuration(22,22100))==60000,"same physical hold accelerates after two seconds");
        k.down(22,22600,true);k.consume(22,22600);
        check(k.heldDuration(22,22700)==2700&&k.longestHeldDuration(22700)==2700,"normal repeat events and diagnostic retain original hold start");
        check(k.release(22)&&k.heldDuration(22,22710)==0,"physical UP erases hold start");
        k.down(22,22800,false);k.consume(22,22800);
        check(SeekPolicy.stepMs(k.heldDuration(22,22800))==10000,"next independent short press resets to ten seconds");
        k.clear();check(k.heldDuration(22,22900)==0&&k.longestHeldDuration(22900)==0,"clear/scene exit erases hold clock");
        k.down(22,30000,false);k.consume(22,30000);
        check(k.heldDuration(22,35001)==0&&!k.owns(22,35001),"lost UP ages out ownership and hold clock together");
        k.down(21,40000,false);k.consume(21,40000);k.down(22,40300,false);k.consume(22,40300);
        check(k.heldDuration(21,40700)==700&&k.heldDuration(22,40700)==400,"independent directions never share heldSince");
        k.release(21);check(k.longestHeldDuration(40700)==400,"releasing one direction preserves the other hold");
        System.out.println("PASS: "+checks+" key intent/hold assertions (50ms race, missing UP, firmware-reset repeats, acceleration reset)");
    }
}
