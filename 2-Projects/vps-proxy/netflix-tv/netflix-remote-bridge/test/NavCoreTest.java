package cn.hahaxiong.netflixremote;
import java.util.Arrays;
import java.util.List;
public class NavCoreTest {
    private static NavCore.Box b(int l,int t,int r,int bot){return new NavCore.Box(l,t,r,bot);}
    private static void eq(int got,int want,String message){if(got!=want)throw new AssertionError(message+": "+got+" != "+want);}
    public static void main(String[] args){
        List<NavCore.Box> grid=Arrays.asList(b(0,0,100,100),b(110,0,210,100),b(0,110,100,210),b(110,110,210,210));
        eq(NavCore.next(grid,0,NavCore.RIGHT),1,"same row right");eq(NavCore.next(grid,0,NavCore.DOWN),2,"same col down");eq(NavCore.next(grid,0,NavCore.LEFT),-1,"no left wrap");
        // Recorded real subtitle rows: wide language hitboxes in two columns.
        List<NavCore.Box> subtitles=Arrays.asList(b(72,282,1836,456),b(72,456,1836,630),b(2004,282,3768,456),b(2004,456,3768,630),b(3541,1968,3768,2112));
        eq(NavCore.next(subtitles,0,NavCore.RIGHT),2,"subtitle cross column");eq(NavCore.next(subtitles,2,NavCore.DOWN),3,"subtitle same column");
        eq(NavCore.next(subtitles,3,NavCore.DOWN),4,"reachable Apply");
        if(NavCore.clip(b(50,210,150,300),b(0,0,200,200))!=null)throw new AssertionError("offscreen ghost");
        NavCore.Box clipped=NavCore.clip(b(50,150,150,250),b(0,0,200,200));eq(clipped.b,200,"visible clip");
        List<NavCore.Box> staggered=Arrays.asList(b(0,0,100,100),b(0,500,100,600),b(101,101,201,201));
        eq(NavCore.next(staggered,0,NavCore.DOWN),1,"aligned column preference");
        System.out.println("PASS: 9 geometry assertions (including actual subtitle bounds)");
    }
}
