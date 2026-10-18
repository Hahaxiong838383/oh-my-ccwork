package cn.hahaxiong.netflixremote;

import java.util.ArrayList;
import java.util.List;

/** Pure geometry/identity policy for the observed Netflix 9.84 New & Hot feed. */
public final class FeedPolicy {
    public static final int NONE=0, CONTENT=1, HEADER=2, DOCK=3;
    public static final class Node {
        public final String path,id;
        public final NavCore.Box bounds;
        public final boolean visible,actionable,checkable,checked,newHotTitle;
        public final int identityHash;
        // newHotTitle is true ONLY for the known toolbar ID with exact text "New & Hot".
        // identityHash is an in-memory hash of text/description, never the text itself.
        public Node(String path,String id,NavCore.Box bounds,boolean visible,boolean actionable,
                    boolean checkable,boolean checked,boolean newHotTitle,int identityHash){
            this.path=path;this.id=id;this.bounds=bounds;this.visible=visible;this.actionable=actionable;
            this.checkable=checkable;this.checked=checked;this.newHotTitle=newHotTitle;this.identityHash=identityHash;
        }
    }
    public static final class Target {
        public final String key,id;public final NavCore.Box bounds;
        public Target(String key,String id,NavCore.Box bounds){this.key=key;this.id=id;this.bounds=bounds;}
    }
    public static final class Scene {
        public final int windowId;
        public final String key,contentPath,dockPath;
        public final NavCore.Box viewport,header,dock;
        public final long signature;
        private final List<Node> nodes;
        private Scene(int windowId,String key,String contentPath,String dockPath,NavCore.Box viewport,
                      NavCore.Box header,NavCore.Box dock,long signature,List<Node> nodes){
            this.windowId=windowId;this.key=key;this.contentPath=contentPath;this.dockPath=dockPath;
            this.viewport=viewport;this.header=header;this.dock=dock;this.signature=signature;this.nodes=new ArrayList<>(nodes);
        }
        public int region(String id,NavCore.Box b){
            if(b==null||!b.valid())return NONE;
            // Ownership precedes geometry: feed nodes can be visible=true BEHIND the dock.
            if(feedId(id))return CONTENT;
            for(Node n:nodes)if(n.id.equals(id)&&equal(n.bounds,b)){
                if(below(n.path,contentPath))return CONTENT;
                if(below(n.path,dockPath))return DOCK;
            }
            if(b.t>=dock.t&&NavCore.clip(b,dock)!=null)return DOCK;
            if(b.b<=header.b&&NavCore.clip(b,header)!=null)return HEADER;
            return NavCore.clip(b,viewport)!=null?CONTENT:NONE;
        }
        /** Apply to both candidate collection and freshly read fallback-click bounds. */
        public NavCore.Box clipCandidate(String id,NavCore.Box b){
            int region=region(id,b);if(region==NONE)return null;
            NavCore.Box c=NavCore.clip(b,region==CONTENT?viewport:region==DOCK?dock:header);
            if(c==null||c.width()<4||c.height()<4)return null;
            // Don't focus a button whose center lies behind the dock/header.
            if(region==CONTENT&&(c.height()*2<b.height()||c.width()*2<b.width()))return null;
            return c;
        }
        public boolean sameScene(Scene other){return other!=null&&windowId==other.windowId&&key.equals(other.key);}
    }
    public static final class Gesture {
        public final float x,startY,endY;public final long durationMs;
        private Gesture(float x,float startY,float endY){this.x=x;this.startY=startY;this.endY=endY;durationMs=420;}
    }
    public static boolean tag(String id,String suffix){return id.equals(suffix)||id.endsWith("/"+suffix);}
    private static boolean equal(NavCore.Box a,NavCore.Box b){return a.l==b.l&&a.t==b.t&&a.r==b.r&&a.b==b.b;}
    private static boolean below(String path,String parent){return path.startsWith(parent+"/");}
    private static String parent(String path){int i=path.lastIndexOf('/');return i<0?"":path.substring(0,i);}
    private static boolean visible(Node n,NavCore.Box screen){return n.visible&&n.bounds.valid()&&NavCore.clip(n.bounds,screen)!=null;}
    private static Node find(List<Node> nodes,String path){for(Node n:nodes)if(n.path.equals(path))return n;return null;}
    private static String common(String a,String b){while(!a.isEmpty()&&!b.equals(a)&&!below(b,a))a=parent(a);return a;}
    private static boolean feedId(String id){return tag(id,"2131429420")||tag(id,"2131429264")||tag(id,"cta1_hawkins")
            ||tag(id,"cta2_hawkins")||tag(id,"2131429454")||tag(id,"2131428866")||tag(id,"2131427485")||tag(id,"2131427829");}
    private static long mix(long h,long value){return (h^value)*1099511628211L;}
    /** blocked must include player, choice menu, focused editor and visible IME. */
    public static Scene detect(List<Node> nodes,NavCore.Box screen,int windowId,boolean blocked){
        if(blocked||screen==null||!screen.valid())return null;
        Node root=null,title=null,back=null,home=null,search=null,mine=null;
        for(Node n:nodes){if(!visible(n,screen))continue;
            if(tag(n.id,"2131427748"))root=n;
            if(tag(n.id,"2131427665")&&n.newHotTitle)title=n;
            if(tag(n.id,"2131428556"))back=n;
            if(tag(n.id,"tab_bar_item_Home"))home=n;
            if(tag(n.id,"tab_bar_item_Search"))search=n;
            if(tag(n.id,"tab_bar_item_MyNetflix"))mine=n;
        }
        if(root==null||title==null||back==null||home==null||search==null||mine==null)return null;
        if(!below(title.path,root.path)||!below(back.path,root.path)||title.bounds.b>screen.t+screen.height()/3)return null;
        String dockCommon=common(common(home.path,search.path),mine.path);Node dock=null;
        for(String p=dockCommon;!p.isEmpty()&&!p.equals(root.path);p=parent(p)){
            Node n=find(nodes,p);if(n==null||!visible(n,screen))continue;
            if(n.bounds.width()>=screen.width()*4/5&&n.bounds.t>screen.y()&&n.bounds.b>=screen.b-screen.height()/10){dock=n;break;}
        }
        if(dock==null)return null;
        String contentPath=null;
        for(Node n:nodes)if(tag(n.id,"2131429420")&&below(n.path,root.path)){
            String p=parent(n.path);boolean preview=false,description=false;
            for(Node sibling:nodes)if(parent(sibling.path).equals(p)){
                if(tag(sibling.id,"2131429454")||tag(sibling.id,"2131428866"))preview=true;
                if(tag(sibling.id,"2131429264"))description=true;
            }
            if(preview&&description){contentPath=p;break;}
        }
        if(contentPath==null)return null;
        int top=Math.max(title.bounds.b,back.bounds.b);Node rail=null;String category="";
        for(Node n:nodes){
            if(!visible(n,screen)||!parent(n.path).equals(root.path)||n.path.equals(contentPath)||n.path.equals(dock.path))continue;
            if(n.bounds.t<top||n.bounds.b>screen.t+screen.height()/2||n.bounds.width()<screen.width()*4/5)continue;
            List<Node> choices=new ArrayList<>();for(Node child:nodes)
                if(below(child.path,n.path)&&child.checkable&&child.actionable&&visible(child,screen))choices.add(child);
            boolean aligned=false,checked=false;String selected="";
            for(int i=0;i<choices.size();i++){
                Node a=choices.get(i);if(a.checked){checked=true;selected=a.path+":"+a.identityHash;}
                for(int j=i+1;j<choices.size();j++){
                    Node b=choices.get(j);if(Math.min(a.bounds.b,b.bounds.b)-Math.max(a.bounds.t,b.bounds.t)>=Math.min(a.bounds.height(),b.bounds.height())/2)aligned=true;
                }
            }
            if(choices.size()>=2&&aligned&&checked){rail=n;category=selected;break;}
        }
        if(rail==null)return null;top=Math.max(top,rail.bounds.b);
        int left=screen.r,right=screen.l;long fingerprint=1469598103934665603L;
        for(Node n:nodes)if(below(n.path,contentPath)&&feedId(n.id)&&n.bounds.valid()&&n.visible){
            NavCore.Box c=NavCore.clip(n.bounds,new NavCore.Box(screen.l,top,screen.r,dock.bounds.t));if(c==null)continue;
            left=Math.min(left,c.l);right=Math.max(right,c.r);
            // Include content identity and vertical position; never include playback time/countdown IDs.
            fingerprint=mix(fingerprint,n.id.hashCode());fingerprint=mix(fingerprint,n.identityHash);
            fingerprint=mix(fingerprint,n.bounds.l);fingerprint=mix(fingerprint,n.bounds.t);
            fingerprint=mix(fingerprint,n.bounds.r);fingerprint=mix(fingerprint,n.bounds.b);
        }
        NavCore.Box viewport=new NavCore.Box(left,top,right,dock.bounds.t);
        if(!viewport.valid()||viewport.height()<screen.height()/3||viewport.width()<screen.width()/5)return null;
        return new Scene(windowId,root.path+"|"+contentPath+"|"+dock.path+"|"+category,contentPath,dock.path,viewport,
                new NavCore.Box(screen.l,screen.t,screen.r,top),NavCore.clip(dock.bounds,screen),fingerprint,nodes);
    }
    /** Relative margins leave the gesture away from both controls and the dock gradient. */
    public static Gesture gesture(Scene scene,int direction){
        if(scene==null||(direction!=NavCore.UP&&direction!=NavCore.DOWN))return null;
        NavCore.Box v=scene.viewport;float high=v.t+v.height()*0.20f,low=v.b-v.height()*0.10f;
        return direction==NavCore.DOWN?new Gesture((float)v.x(),low,high):new Gesture((float)v.x(),high,low);
    }
}
