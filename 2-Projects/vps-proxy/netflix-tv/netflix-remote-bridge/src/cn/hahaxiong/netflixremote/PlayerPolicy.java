package cn.hahaxiong.netflixremote;

/** Player-specific routing, independent of Android for regression against real node dumps. */
public final class PlayerPolicy {
    private static boolean tag(String id,String name){return id.equals(name)||id.endsWith("/"+name);}
    public static boolean isTransport(String id){return tag(id,"playPauseButtonTestTag")||tag(id,"pauseButtonTestTag")||tag(id,"playButtonTestTag")||tag(id,"backwardSeekButtonTestTag")||tag(id,"forwardSeekButtonTestTag");}
    public static boolean isControl(String id){return isTransport(id)||tag(id,"seekbar")||tag(id,"audioAndSubtitlesButtonTestTag")||tag(id,"playerBackButtonTestTag")||tag(id,"lockButtonTestTag")||tag(id,"momentsButtonTestTag")||tag(id,"speedButtonTestTag")||tag(id,"episodesButtonTestTag")||tag(id,"nextEpisodeButtonTestTag");}
    public static boolean actionableControl(String id,boolean clickable,boolean hasClick){return isControl(id)&&(clickable||hasClick);}
    public static boolean seekKeys(boolean player,boolean choiceMenu,boolean controls,String selectedId){return player&&!choiceMenu&&(!controls||isTransport(selectedId));}
    public static boolean waitForControls(boolean player,boolean choiceMenu,boolean controls,boolean transportPresent,int selected){return player&&!choiceMenu&&controls&&(!transportPresent||selected<0);}
}
