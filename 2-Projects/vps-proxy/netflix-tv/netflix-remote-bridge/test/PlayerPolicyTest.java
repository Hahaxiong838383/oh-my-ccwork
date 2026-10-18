package cn.hahaxiong.netflixremote;
public class PlayerPolicyTest {
    private static void check(boolean result,String why){if(!result)throw new AssertionError(why);}
    public static void main(String[] args){
        // Recorded from bridge-player-dump.txt: wrapper actions=[64], child pause actions=[1,64,16].
        check(!PlayerPolicy.actionableControl("playPauseButtonTestTag",false,false),"real non-clickable wrapper must not reveal controls");
        check(PlayerPolicy.actionableControl("pauseButtonTestTag",true,true),"real pause child remains actionable");
        check(PlayerPolicy.actionableControl("playPauseButtonTestTag",false,true),"a variant with genuine ACTION_CLICK remains supported");
        check(PlayerPolicy.seekKeys(true,false,false,""),"hidden player routes seek keys");
        check(PlayerPolicy.seekKeys(true,false,true,"pauseButtonTestTag"),"pause selection routes seek keys");
        check(PlayerPolicy.seekKeys(true,false,true,"forwardSeekButtonTestTag"),"seek selection routes seek keys");
        check(!PlayerPolicy.seekKeys(true,false,true,"episodesButtonTestTag"),"bottom episodes uses spatial navigation");
        check(!PlayerPolicy.seekKeys(true,false,true,"audioAndSubtitlesButtonTestTag"),"bottom subtitles uses spatial navigation");
        check(!PlayerPolicy.seekKeys(true,true,true,"pauseButtonTestTag"),"choice dialog overrides transport");
        check(!PlayerPolicy.seekKeys(false,false,false,""),"non-player never seeks");
        check(PlayerPolicy.waitForControls(true,false,true,false,0),"actual seek transition: only Back remains, never click it");
        check(PlayerPolicy.waitForControls(true,false,true,true,-1),"missing primary selection must not fall through to native OK");
        check(!PlayerPolicy.waitForControls(true,false,false,false,-1),"hidden controls must still permit reveal");
        check(!PlayerPolicy.waitForControls(true,true,true,false,0),"subtitle choice menu keeps navigation");
        check(!PlayerPolicy.waitForControls(true,false,true,true,4),"explicit Back selection with normal transport remains valid");
        System.out.println("PASS: 15 player regression assertions (real wrapper/seek transition and menu routing)");
    }
}
