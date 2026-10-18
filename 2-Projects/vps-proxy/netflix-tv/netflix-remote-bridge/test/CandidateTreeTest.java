package cn.hahaxiong.netflixremote;

import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class CandidateTreeTest {
    private static int checks;
    private static void check(boolean v,String why){checks++;if(!v)throw new AssertionError(why);}
    private static class Node {
        String path,id;NavCore.Box bounds;boolean visible,clickable,checkable,editable,enabled,scrollable,hasClick;
        List<Node> children=new ArrayList<>();
    }
    private static NavCore.Box parseBox(String value){Matcher m=Pattern.compile("\\[(-?\\d+),(-?\\d+)\\]\\[(-?\\d+),(-?\\d+)\\]").matcher(value);if(!m.find())throw new AssertionError(value);return new NavCore.Box(Integer.parseInt(m.group(1)),Integer.parseInt(m.group(2)),Integer.parseInt(m.group(3)),Integer.parseInt(m.group(4)));}
    private static List<Node> collect(Node root){
        List<Node> out=new ArrayList<>();
        CandidateTree.collect(root,new NavCore.Box(0,0,3840,2160),new CandidateTree.Adapter<Node>(){
            public NavCore.Box bounds(Node n){return n.bounds;}public boolean visible(Node n){return n.visible;}public boolean clipsChildren(Node n){return n.scrollable;}
            public int childCount(Node n){return n.children.size();}public Node child(Node n,int i){return n.children.get(i);}public void release(Node n){}
        },new CandidateTree.Visitor<Node>(){
            public void visible(Node n,NavCore.Box b){}
            public boolean keep(Node n,NavCore.Box b,int descendants){
                List<String> childIds=new ArrayList<>();for(Node child:n.children)childIds.add(child.id);
                return NodePolicy.keep(n.enabled,n.clickable||n.hasClick,n.checkable,n.editable,PlayerPolicy.isControl(n.id),descendants,NodePolicy.continueWatchingCard(n.id,childIds));
            }
            public void candidate(Node n,NavCore.Box b){out.add(n);}
        });return out;
    }
    private static int find(List<Node> nodes,String id,int left){for(int i=0;i<nodes.size();i++)if(nodes.get(i).id.equals(id)&&nodes.get(i).bounds.l==left)return i;return -1;}
    private static Node synthetic(String id,NavCore.Box b,boolean visible,boolean click,boolean scroll){Node n=new Node();n.id=id;n.bounds=b;n.visible=visible;n.clickable=click;n.enabled=true;n.scrollable=scroll;return n;}
    public static void main(String[] args)throws Exception{
        Map<String,Node> nodes=new LinkedHashMap<>();
        Pattern header=Pattern.compile("node path=(\\S+) id=(.*?) bounds=(\\[.*?\\]\\[.*?\\]) ");
        for(String line:Files.readAllLines(Paths.get("test/fixtures/cw-nodes.txt"))){
            Matcher m=header.matcher(line);if(!m.find())throw new AssertionError(line);
            Node n=new Node();n.path=m.group(1);n.id=m.group(2);n.bounds=parseBox(m.group(3));
            n.visible=line.contains(" visible=true ");n.clickable=line.contains(" clickable=true ");n.checkable=line.contains(" checkable=true ");n.editable=line.contains(" editable=true ");n.enabled=line.contains(" enabled=true ");n.scrollable=line.contains(" scrollable=true ");
            String actionText=line.substring(line.indexOf("actions=[")+9,line.lastIndexOf(']'));n.hasClick=Arrays.asList(actionText.split(",")).contains("16");
            nodes.put(n.path,n);int slash=n.path.lastIndexOf('/');if(slash>=0)nodes.get(n.path.substring(0,slash)).children.add(n);
        }
        check(nodes.size()==63,"fixture is complete real 63-node dump");
        List<Node> visible=collect(nodes.get("0"));
        check(visible.size()==17,"real tree now includes original 11 + two Play cards + four accessory buttons");
        String play="com.netflix.mediaclient:id/2131427788",info="com.netflix.mediaclient:id/2131427786",more="com.netflix.mediaclient:id/2131427791";
        int first=find(visible,play,36),second=find(visible,play,649);
        check(first>=0,"first visible Play survives invisible wrapper");check(second>=0,"second visible Play survives invisible wrapper");
        check(find(visible,info,136)>=0&&find(visible,info,749)>=0,"both Info actions remain available");
        check(find(visible,more,435)>=0&&find(visible,more,1048)>=0,"both More actions remain available");
        check(visible.get(first).bounds.t==650&&visible.get(first).bounds.b==1626,"first card exact live bounds");
        List<NavCore.Box> boxes=new ArrayList<>();for(Node n:visible)boxes.add(n.bounds);
        check(NavCore.next(boxes,first,NavCore.RIGHT)==second,"right from first card selects second Play, not accessory");
        check(NavCore.next(boxes,second,NavCore.LEFT)==first,"left from second card selects first Play");
        Node invisible=synthetic("invisible",new NavCore.Box(0,0,500,500),false,true,false);
        invisible.children.add(synthetic("visible-child",new NavCore.Box(10,10,100,100),true,true,false));
        List<Node> one=collect(invisible);check(one.size()==1&&one.get(0).id.equals("visible-child"),"invisible wrapper never becomes a target but its visible child does");
        Node scroll=synthetic("scroll",new NavCore.Box(0,0,500,500),true,false,true);
        scroll.children.add(synthetic("offscreen",new NavCore.Box(10,600,100,700),true,true,false));
        check(collect(scroll).isEmpty(),"scroll viewport still excludes offscreen ghosts");
        check(!NodePolicy.keep(true,true,false,false,false,1,false),"ordinary clickable wrapper remains excluded");
        Map<String,List<NavCore.Box>> groups=new LinkedHashMap<>();
        for(String line:Files.readAllLines(Paths.get("test/fixtures/subtitle-choices.tsv"))){String[] p=line.split("\\t");if(!groups.containsKey(p[0]))groups.put(p[0],new ArrayList<>());groups.get(p[0]).add(parseBox(p[1]));}
        check(groups.size()==2,"real subtitle fixture has audio/subtitle columns");
        for(List<NavCore.Box> group:groups.values())check(NodePolicy.choiceGroup(group,false),"real View-class subtitle choices remain a dialog");
        check(!NodePolicy.choiceGroup(Arrays.asList(new NavCore.Box(100,100,300,200)),false),"single postplay My List toggle cannot suppress Play");
        check(!NodePolicy.choiceGroup(Arrays.asList(new NavCore.Box(100,100,300,200),new NavCore.Box(400,100,600,200)),false),"unrelated horizontal toggles are not a language menu");
        check(NodePolicy.choiceGroup(new ArrayList<>(),true),"explicit RadioButton role remains supported");
        System.out.println("PASS: "+checks+" real-tree/choice regressions (63 CW nodes + 19 subtitle choices)");
    }
}
