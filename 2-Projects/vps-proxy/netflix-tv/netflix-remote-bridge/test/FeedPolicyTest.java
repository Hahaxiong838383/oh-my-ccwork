package cn.hahaxiong.netflixremote;

import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class FeedPolicyTest {
    private static int checks;
    private static final NavCore.Box SCREEN=new NavCore.Box(0,0,3840,2160);
    private static final String P="com.netflix.mediaclient:id/";
    private static void check(boolean b,String why){checks++;if(!b)throw new AssertionError(why);}
    private static NavCore.Box box(String s){Matcher m=Pattern.compile("\\[(-?\\d+),(-?\\d+)\\]\\[(-?\\d+),(-?\\d+)\\]").matcher(s);if(!m.find())throw new AssertionError(s);return new NavCore.Box(Integer.parseInt(m.group(1)),Integer.parseInt(m.group(2)),Integer.parseInt(m.group(3)),Integer.parseInt(m.group(4)));}
    static List<FeedPolicy.Node> fixture(String name)throws Exception{
        List<FeedPolicy.Node> out=new ArrayList<>();
        Pattern p=Pattern.compile("node path=(\\S+) id=(.*?)(?: class=.*?)? bounds=(\\[.*?\\]\\[.*?\\]) ");
        for(String line:Files.readAllLines(Paths.get("test/fixtures/"+name))){
            Matcher m=p.matcher(line);if(!m.find())throw new AssertionError(line);
            out.add(new FeedPolicy.Node(m.group(1),m.group(2),box(m.group(3)),line.contains(" visible=true "),
                    line.contains(" clickable=true "),line.contains(" checkable=true "),line.contains(" checked=true "),line.contains("newHotTitle=true"),0));
        }return out;
    }
    private static List<FeedPolicy.Target> targets(List<FeedPolicy.Node> nodes,FeedPolicy.Scene scene,boolean filter){
        List<FeedPolicy.Target> out=new ArrayList<>();
        for(FeedPolicy.Node n:nodes)if(n.visible&&n.actionable&&n.bounds.valid()){
            NavCore.Box b=filter?scene.clipCandidate(n.id,n.bounds):n.bounds;
            if(b!=null)out.add(new FeedPolicy.Target(n.path+"|"+n.id,n.id,b));
        }return out;
    }
    private static int index(List<FeedPolicy.Target> ts,String id){for(int i=0;i<ts.size();i++)if(FeedPolicy.tag(ts.get(i).id,id))return i;return -1;}
    private static FeedPolicy.Node copy(FeedPolicy.Node n,NavCore.Box b,boolean visible,boolean marker,int hash){
        return new FeedPolicy.Node(n.path,n.id,b,visible,n.actionable,n.checkable,n.checked,marker,hash);
    }
    private static List<FeedPolicy.Node> without(List<FeedPolicy.Node> ns,String suffix){List<FeedPolicy.Node> out=new ArrayList<>();for(FeedPolicy.Node n:ns)if(!FeedPolicy.tag(n.id,suffix))out.add(n);return out;}
    private static FeedPolicy.Scene detect(List<FeedPolicy.Node> ns){return FeedPolicy.detect(ns,SCREEN,344,false);}
    public static void main(String[] args)throws Exception{
        List<FeedPolicy.Node> before=fixture("feed-before.txt"),after=fixture("feed-after-touch.txt"),top10=fixture("feed-top10.txt");
        check(before.size()==66,"full before fixture");check(after.size()==67,"full after fixture");
        FeedPolicy.Scene a=detect(before),b=detect(after),t=detect(top10);
        check(a!=null&&b!=null&&t!=null,"all THREE real scenes identified: replay-only, active-preview and top10");
        check(a.viewport.t==300&&a.viewport.b==1908,"viewport derived from true header and outer dock");
        check(a.viewport.l==1062&&a.viewport.r==2778,"before gesture content horizontal geometry");
        check(b.viewport.l==1026&&b.viewport.r==2814,"after preview expands live horizontal viewport");
        check(a.signature!=b.signature,"actual scroll changes non-text fingerprint");
        check(a.clipCandidate(P+"cta1_hawkins",new NavCore.Box(1062,1860,1505,2001))==null,"48/141 CTA sliver is not focusable");
        check(b.clipCandidate(P+"2131429264",new NavCore.Box(1062,2030,2778,2160))==null,"hidden synopsis is content, not dock");
        check(b.clipCandidate(P+"2131429420",new NavCore.Box(1062,1691,2778,1913)).b==1908,"five-pixel title occlusion safely clipped");
        check(t.clipCandidate(P+"cta1_hawkins",new NavCore.Box(1062,2064,1350,2160))==null,"real top10 Play fully behind dock excluded");
        check(t.clipCandidate(P+"cta2_hawkins",new NavCore.Box(1362,2064,1717,2160))==null,"real top10 MyList behind dock excluded");
        check(t.clipCandidate(P+"2131429264",new NavCore.Box(1062,1882,2778,2016))==null,"real top10 partial synopsis excluded");
        check(t.clipCandidate("tab_bar_item_Search",new NavCore.Box(1652,1968,1880,2112))!=null,"actual dock Search remains reachable");
        check(a.clipCandidate(P+"2131429264",new NavCore.Box(100,2500,300,2160))==null,"inverted offscreen geometry rejected");
        check(FeedPolicy.detect(before,SCREEN,344,true)==null,"player/choice/editor/IME blocked");
        check(detect(without(before,"2131427665"))==null,"no toolbar: fail closed");
        check(detect(without(before,"2131427748"))==null,"no recognized root: fail closed");
        check(detect(without(before,"tab_bar_item_Search"))==null,"no dock anchor: fail closed");
        check(detect(without(before,"2131428866"))==null,"no preview or replay structure: fail closed");
        List<FeedPolicy.Node> wrongTitle=new ArrayList<>(),transition=new ArrayList<>(),identity=new ArrayList<>(),hidden=new ArrayList<>();
        for(FeedPolicy.Node n:before){
            wrongTitle.add(copy(n,n.bounds,n.visible,false,n.identityHash));
            transition.add(copy(n,n.bounds,FeedPolicy.tag(n.id,"2131429420")?false:n.visible,n.newHotTitle,n.identityHash));
            identity.add(copy(n,n.bounds,n.visible,n.newHotTitle,FeedPolicy.tag(n.id,"2131429420")?12345:n.identityHash));
            hidden.add(copy(n,n.bounds,n.path.startsWith("0/0/0/")?false:n.visible,n.newHotTitle,n.identityHash));
        }
        check(detect(wrongTitle)==null,"same root/IDs on another page cannot trigger feed");
        check(detect(transition)!=null,"mid-scroll absent visible title keeps strict structural scene");
        check(detect(hidden)==null,"structure alone without any visible content does not permit a swipe");
        check(detect(identity).signature!=a.signature,"same layout but another title changes identity fingerprint");
        FeedPolicy.Gesture down=FeedPolicy.gesture(a,NavCore.DOWN),up=FeedPolicy.gesture(a,NavCore.UP);
        check(down.startY>down.endY&&up.startY<up.endY,"down scroll swipes up, up scroll swipes down");
        check(down.startY<1833&&down.endY>300&&down.x==1920,"gesture stays inside real content away from dock fade/header");
        FeedNavigator nav=new FeedNavigator();List<FeedPolicy.Target> first=targets(before,a,true),last=targets(after,b,true),top=targets(top10,t,true);
        int title=index(first,"2131429420"),synopsis=index(first,"2131429264"),search=index(first,"tab_bar_item_Search");
        FeedNavigator.Plan fromBack=nav.plan(a,first,index(first,"2131428556"),NavCore.DOWN,0);
        check(fromBack.action==FeedNavigator.MOVE&&a.region(first.get(fromBack.index).id,first.get(fromBack.index).bounds)==FeedPolicy.HEADER,"back DOWN keeps category chips reachable");
        FeedNavigator.Plan fromChip=nav.plan(a,first,fromBack.index,NavCore.DOWN,0);
        check(fromChip.action==FeedNavigator.MOVE&&a.region(first.get(fromChip.index).id,first.get(fromChip.index).bounds)==FeedPolicy.CONTENT,"category DOWN enters content");
        check(nav.plan(a,first,title,NavCore.DOWN,0).index==synopsis,"DOWN finds same-content synopsis before any nearer dock");
        check(nav.plan(a,first,synopsis,NavCore.DOWN,0).action==FeedNavigator.SWIPE,"DOWN at content edge scrolls, never enters kids");
        check(nav.plan(a,first,synopsis,NavCore.DOWN,700).action==FeedNavigator.SWIPE,"held edge DOWN continues browsing, never jumps dock");
        check(nav.plan(a,first,search,NavCore.UP,0).index==synopsis,"dock UP returns to last content key");
        check(nav.plan(a,first,search,NavCore.DOWN,0).action==FeedNavigator.MOVE,"dock DOWN never scrolls content");
        check(nav.plan(a,first,index(first,"2131428866"),NavCore.UP,0).action==FeedNavigator.SWIPE,"UP at content edge scrolls toward previous item");
        FeedNavigator.Plan exitTop=nav.plan(a,first,index(first,"2131428866"),NavCore.UP,700);
        check(exitTop.action==FeedNavigator.SWIPE,"held edge UP continues browsing");
        check(nav.plan(t,top,index(top,"2131429420"),NavCore.DOWN,0).action==FeedNavigator.SWIPE,"real top10 title edge does not target masked Play/MyList");
        int restored=nav.restoreFocus(b,last);check(restored>=0&&b.region(last.get(restored).id,last.get(restored).bounds)==FeedPolicy.CONTENT,"after-scroll focus stays in content");
        FeedNavigator.Attempt attempt=nav.prepare(a,NavCore.DOWN,7);
        check(nav.resolve(attempt,b,7,true)==null,"held key cannot dispatch");
        check(nav.resolve(attempt,b,8,false)==null,"new input generation cancels old swipe");
        check(nav.resolve(attempt,FeedPolicy.detect(after,SCREEN,345,false),7,false)==null,"window changed cancels old swipe");
        check(nav.resolve(attempt,null,7,false)==null,"scene lost cancels old swipe");
        check(nav.resolve(attempt,t,7,false)==null,"category changed cancels old swipe");
        check(nav.resolve(attempt,b,7,false)!=null,"fresh matching feed can resolve after key up");
        check(nav.atDispatch(attempt,b,7).before.signature==b.signature,"dispatch captures fresh baseline");
        nav.reset();FeedNavigator.Observation early=new FeedNavigator.Observation(a,350),late=new FeedNavigator.Observation(a,950);
        nav.finish(attempt,early,late,false,7);check(nav.unchangedAttempts(NavCore.DOWN)==0,"cancelled gesture not a boundary");
        nav.finish(attempt,early,new FeedNavigator.Observation(a,450),true,7);check(nav.unchangedAttempts(NavCore.DOWN)==0,"early static frame not a boundary");
        nav.finish(attempt,early,late,true,8);check(nav.unchangedAttempts(NavCore.DOWN)==0,"new input invalidates delayed result");
        nav.finish(attempt,early,late,true,7);check(nav.unchangedAttempts(NavCore.DOWN)==1,"one settled unchanged completion still not terminal");
        nav.finish(attempt,early,late,true,7);check(nav.unchangedAttempts(NavCore.DOWN)==1,"one attempt cannot count twice");
        check(nav.plan(a,first,synopsis,NavCore.DOWN,0).action==FeedNavigator.SWIPE,"one failure allows retry");
        nav.finish(nav.prepare(a,NavCore.DOWN,8),early,late,true,8);
        check(nav.plan(a,first,synopsis,NavCore.DOWN,0).action==FeedNavigator.MOVE,"two settled attempts allow natural dock exit");
        check(nav.plan(b,last,index(last,"2131429420"),NavCore.DOWN,0).action==FeedNavigator.SWIPE,"new content resets stale endpoint latch");
        System.out.println("PASS: "+checks+" feed policy/navigation checks using THREE real structural fixtures");
    }
}
