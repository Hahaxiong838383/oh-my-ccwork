package cn.hahaxiong.netflixremote;

/** Netflix 9.84's observed seekbar exposes a millisecond RangeInfo and SET_PROGRESS. */
public final class SeekPolicy {
    public static final class Range {
        public final float min,max,current;
        public Range(float min,float max,float current){this.min=min;this.max=max;this.current=current;}
    }
    public static boolean isSeekbarId(String id){return "seekbar".equals(id)||id.endsWith("/seekbar");}
    public static boolean valid(Range range){return range!=null&&Float.isFinite(range.min)&&Float.isFinite(range.max)&&Float.isFinite(range.current)&&range.min>=0&&range.max>range.min&&range.max>=1000&&range.current>=range.min&&range.current<=range.max;}
    public static boolean seekbar(String id,Range range,boolean setProgress){return isSeekbarId(id)&&valid(range)&&setProgress;}
    public static long stepMs(long heldMs){return heldMs>=2000?60000:heldMs>=700?30000:10000;}
    public static float clamp(Range range,float value){return Math.max(range.min,Math.min(range.max,value));}
    public static float fraction(Range range,float value){return (clamp(range,value)-range.min)/(range.max-range.min);}
    public static String formatMs(float value){
        long seconds=Math.max(0,Math.round(value/1000.0));long h=seconds/3600,m=(seconds%3600)/60,s=seconds%60;
        return h>0?String.format(java.util.Locale.ROOT,"%d:%02d:%02d",h,m,s):String.format(java.util.Locale.ROOT,"%d:%02d",m,s);
    }
    /** Local preview only: no Netflix mutation happens until the service confirms on OK/KEY_UP. */
    public static final class Draft {
        private Range range;private float target;
        public boolean active(){return range!=null;}
        public float target(){return target;}
        public boolean matches(Range live){return active()&&valid(live)&&range.min==live.min&&range.max==live.max;}
        public void preview(Range live,int direction,long heldMs){
            if(!valid(live))return;
            if(!matches(live)){range=live;target=live.current;}
            adjust(direction,heldMs);
        }
        public void adjust(int direction,long heldMs){if(active())target=clamp(range,target+(direction<0?-1:1)*stepMs(heldMs));}
        public void cancel(){range=null;target=0;}
    }
}
