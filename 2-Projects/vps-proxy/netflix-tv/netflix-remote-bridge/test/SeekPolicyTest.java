package cn.hahaxiong.netflixremote;

import java.nio.file.*;
import java.util.*;
import java.util.regex.*;

public final class SeekPolicyTest {
    private static int checks;
    private static void check(boolean value,String why){checks++;if(!value)throw new AssertionError(why);}
    private static final class Node {
        String path,id;NavCore.Box box;SeekPolicy.Range range;
        boolean visible,enabled,click,checkable,editable,scroll,setProgress;List<Node> children=new ArrayList<>();
    }
    public static void main(String[] args)throws Exception{
        Map<String,Node> nodes=new LinkedHashMap<>();
        Pattern p=Pattern.compile("node path=(\\S+) id=(.*?) class=(.*?) range=(.*?) bounds=\\[(-?\\d+),(-?\\d+)\\]\\[(-?\\d+),(-?\\d+)\\]");
        Pattern r=Pattern.compile("min=([^,]+),max=([^,]+),current=([^\\]]+)");
        Node realSeek=null,brightness=null;
        for(String line:Files.readAllLines(Paths.get("test/fixtures/player-range-nodes.txt"))){
            Matcher m=p.matcher(line);if(!m.find())throw new AssertionError(line);
            Node n=new Node();n.path=m.group(1);n.id=m.group(2);n.box=new NavCore.Box(Integer.parseInt(m.group(5)),Integer.parseInt(m.group(6)),Integer.parseInt(m.group(7)),Integer.parseInt(m.group(8)));
            Matcher range=r.matcher(m.group(4));if(range.find())n.range=new SeekPolicy.Range(Float.parseFloat(range.group(1)),Float.parseFloat(range.group(2)),Float.parseFloat(range.group(3)));
            n.visible=line.contains(" visible=true ");n.enabled=line.contains(" enabled=true ");n.checkable=line.contains(" checkable=true ");n.editable=line.contains(" editable=true ");n.scroll=line.contains(" scrollable=true ");
            List<String> actions=Arrays.asList(line.substring(line.indexOf("actions=[")+9,line.lastIndexOf(']')).split(","));n.click=line.contains(" clickable=true ")||actions.contains("16");n.setProgress=actions.contains("16908349");
            nodes.put(n.path,n);int slash=n.path.lastIndexOf('/');if(slash>=0)nodes.get(n.path.substring(0,slash)).children.add(n);
            if(n.id.equals("seekbar"))realSeek=n;if(n.id.equals("brightnessSlider"))brightness=n;
        }
        check(nodes.size()==54,"complete 54-node live paused-player snapshot");
        check(realSeek!=null&&realSeek.range.max==1620000&&realSeek.range.current==1503739,"recorded Netflix range is milliseconds");
        check(!realSeek.click&&realSeek.setProgress,"real regression: nonclickable native SET_PROGRESS target");
        check(SeekPolicy.seekbar(realSeek.id,realSeek.range,realSeek.setProgress),"real seekbar accepted");
        check(!SeekPolicy.seekbar(brightness.id,brightness.range,brightness.setProgress),"real brightness slider excluded despite same role/actions");
        check(!SeekPolicy.seekbar("seekbar",new SeekPolicy.Range(0,1,.5f),true),"unknown normalized units never treated as milliseconds");
        check(!SeekPolicy.seekbar("seekbar",realSeek.range,false),"no invented action when SET_PROGRESS absent");
        check(!SeekPolicy.valid(new SeekPolicy.Range(0,Float.NaN,0)),"invalid bounds excluded");
        List<Node> targets=new ArrayList<>();List<NavCore.Box> boxes=new ArrayList<>();
        CandidateTree.collect(nodes.get("0"),new NavCore.Box(0,0,3840,2160),new CandidateTree.Adapter<Node>(){
            public NavCore.Box bounds(Node n){return n.box;}public boolean visible(Node n){return n.visible;}public boolean clipsChildren(Node n){return n.scroll;}
            public int childCount(Node n){return n.children.size();}public Node child(Node n,int i){return n.children.get(i);}public void release(Node n){}
        },new CandidateTree.Visitor<Node>(){
            public void visible(Node n,NavCore.Box b){}
            public boolean keep(Node n,NavCore.Box b,int descendants){
                if(n.id.equals("playerTappableContainerTestTag"))return false;
                if(n.enabled&&SeekPolicy.seekbar(n.id,n.range,n.setProgress))return true;
                List<String> children=new ArrayList<>();for(Node c:n.children)children.add(c.id);
                return NodePolicy.keep(n.enabled,n.click,n.checkable,n.editable,PlayerPolicy.isControl(n.id),descendants,NodePolicy.continueWatchingCard(n.id,children));
            }
            public void candidate(Node n,NavCore.Box b){targets.add(n);boxes.add(b);}
        });
        check(targets.size()==9,"eight existing controls plus actual seekbar, no brightness or wrappers");
        int play=-1,seek=-1,speed=-1;for(int i=0;i<targets.size();i++){String id=targets.get(i).id;if(id.equals("playButtonTestTag"))play=i;if(id.equals("seekbar"))seek=i;if(id.equals("speedButtonTestTag"))speed=i;}
        check(NavCore.next(boxes,play,NavCore.DOWN)==seek,"DOWN from central play selects actual seekbar");
        check(NavCore.next(boxes,seek,NavCore.DOWN)==speed,"DOWN from seekbar reaches bottom menu");
        check(NavCore.next(boxes,seek,NavCore.UP)==play,"UP from seekbar returns to central play");
        check(!PlayerPolicy.seekKeys(true,false,true,"seekbar"),"seekbar preview is not old immediate ten-second button branch");
        SeekPolicy.Draft draft=new SeekPolicy.Draft();check(!draft.active(),"selection alone cannot mutate playback");
        draft.preview(realSeek.range,1,0);check(draft.target()==1513739,"short right previews exactly ten seconds");
        draft.preview(new SeekPolicy.Range(0,1620000,1509000),-1,0);check(draft.target()==1503739,"playback progress cannot overwrite local preview");
        draft.preview(realSeek.range,-1,700);check(draft.target()==1473739,"medium hold previews thirty seconds");
        draft.preview(realSeek.range,1,2000);check(draft.target()==1533739,"long hold previews sixty seconds");
        draft.cancel();check(!draft.active(),"BACK or vertical navigation discards draft");
        draft.preview(new SeekPolicy.Range(0,1620000,3000),-1,0);check(draft.target()==0,"clamps before start");
        draft.cancel();draft.preview(new SeekPolicy.Range(0,1620000,1619000),1,0);check(draft.target()==1620000,"clamps past end");
        draft.adjust(-1,0);check(draft.target()==1610000,"hidden controls retain and adjust the same local draft");
        check(!draft.matches(new SeekPolicy.Range(0,7200000,1619000)),"changed item duration invalidates previous draft");
        check(SeekPolicy.formatMs(1503739).equals("25:04")&&SeekPolicy.formatMs(3661000).equals("1:01:01"),"numeric overlay represents actual media time");
        check(SeekPolicy.fraction(realSeek.range,realSeek.range.max)==1,"preview marker reaches exact range end");
        System.out.println("PASS: "+checks+" seek regressions (actual 54-node player/brightness sample and preview-only editing)");
    }
}
