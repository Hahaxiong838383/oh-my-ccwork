package cn.hahaxiong.netflixremote;

/** Traverses each node's own visibility; an invisible wrapper is not a hidden subtree. */
public final class CandidateTree {
    public interface Adapter<N> {
        NavCore.Box bounds(N node); boolean visible(N node); boolean clipsChildren(N node);
        int childCount(N node); N child(N node,int index); void release(N node);
    }
    public interface Visitor<N> {
        void visible(N node,NavCore.Box bounds);
        boolean keep(N node,NavCore.Box bounds,int actionableDescendants);
        void candidate(N node,NavCore.Box bounds);
    }
    public static <N> int collect(N root,NavCore.Box viewport,Adapter<N> adapter,Visitor<N> visitor){
        return walk(root,viewport,adapter,visitor,0,new int[]{0});
    }
    private static <N> int walk(N node,NavCore.Box clip,Adapter<N> adapter,Visitor<N> visitor,int depth,int[] visited){
        if(depth>45||visited[0]++>=2000)return 0;
        NavCore.Box raw=adapter.bounds(node),visible=NavCore.clip(raw,clip);
        boolean selfVisible=adapter.visible(node)&&visible!=null&&visible.width()>=4&&visible.height()>=4;
        if(selfVisible)visitor.visible(node,visible);
        NavCore.Box childClip=clip;
        if((depth==0||adapter.clipsChildren(node))&&raw.valid())childClip=visible==null?new NavCore.Box(0,0,0,0):visible;
        int descendants=0;
        for(int i=0;i<adapter.childCount(node);i++){
            N child=adapter.child(node,i);if(child==null)continue;
            try{descendants+=walk(child,childClip,adapter,visitor,depth+1,visited);}finally{adapter.release(child);}
        }
        if(selfVisible&&visitor.keep(node,visible,descendants)){visitor.candidate(node,visible);return descendants+1;}
        return descendants;
    }
}
