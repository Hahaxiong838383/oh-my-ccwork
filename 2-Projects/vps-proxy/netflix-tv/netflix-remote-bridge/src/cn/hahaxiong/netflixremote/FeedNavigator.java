package cn.hahaxiong.netflixremote;

import java.util.ArrayList;
import java.util.List;

/** State is scoped to a recognized feed/window; Android dispatch remains in BridgeService. */
public final class FeedNavigator {
    public static final int PASS=0,MOVE=1,SWIPE=2;
    public static final long SETTLED_MS=900;
    public static final class Plan {
        public final int action,index,direction;
        private Plan(int action,int index,int direction){this.action=action;this.index=index;this.direction=direction;}
    }
    public static final class Attempt {
        public final FeedPolicy.Scene before;public final int direction;public final long generation;private boolean finished;
        private Attempt(FeedPolicy.Scene before,int direction,long generation){this.before=before;this.direction=direction;this.generation=generation;}
    }
    public static final class Observation {
        public final FeedPolicy.Scene scene;public final long elapsedMs;
        public Observation(FeedPolicy.Scene scene,long elapsedMs){this.scene=scene;this.elapsedMs=elapsedMs;}
    }
    private FeedPolicy.Scene tracked;
    private int failedUp,failedDown;
    private String contentKey="";
    public void reset(){tracked=null;failedUp=failedDown=0;contentKey="";}
    private void track(FeedPolicy.Scene s){
        if(s==null){reset();return;}
        if(tracked==null||!tracked.sameScene(s)){reset();tracked=s;}
        else if(tracked.signature!=s.signature){failedUp=failedDown=0;tracked=s;}
    }
    private boolean boundary(int direction){return direction==NavCore.UP?failedUp>=2:failedDown>=2;}
    private static int nextIn(FeedPolicy.Scene scene,List<FeedPolicy.Target> targets,int selected,int direction,int region){
        List<NavCore.Box> boxes=new ArrayList<>();List<Integer> indexes=new ArrayList<>();int local=-1;
        for(int i=0;i<targets.size();i++){
            FeedPolicy.Target t=targets.get(i);NavCore.Box b=scene.clipCandidate(t.id,t.bounds);
            if(b==null||scene.region(t.id,t.bounds)!=region)continue;
            if(i==selected)local=boxes.size();boxes.add(b);indexes.add(i);
        }
        if(local<0)return -1;int n=NavCore.next(boxes,local,direction);return n<0?-1:indexes.get(n);
    }
    private static int nearestIn(FeedPolicy.Scene scene,List<FeedPolicy.Target> targets,int region,double x,double y){
        int selected=-1;double best=Double.MAX_VALUE;
        for(int i=0;i<targets.size();i++){
            FeedPolicy.Target t=targets.get(i);NavCore.Box b=scene.clipCandidate(t.id,t.bounds);
            if(b==null||scene.region(t.id,t.bounds)!=region)continue;
            double dx=b.x()-x,dy=b.y()-y,score=dx*dx+dy*dy;
            if(score<best){best=score;selected=i;}
        }return selected;
    }
    public Plan plan(FeedPolicy.Scene scene,List<FeedPolicy.Target> targets,int selected,int direction,long heldMs){
        track(scene);if(scene==null)return new Plan(PASS,-1,direction);
        if(selected<0||selected>=targets.size())return new Plan(PASS,-1,direction);
        FeedPolicy.Target from=targets.get(selected);int region=scene.region(from.id,from.bounds);
        if(region==FeedPolicy.DOCK){
            if(direction==NavCore.UP){int restore=-1;for(int i=0;i<targets.size();i++)if(targets.get(i).key.equals(contentKey)
                    &&scene.region(targets.get(i).id,targets.get(i).bounds)==FeedPolicy.CONTENT&&scene.clipCandidate(targets.get(i).id,targets.get(i).bounds)!=null){restore=i;break;}
                if(restore<0)restore=restoreFocus(scene,targets);return new Plan(MOVE,restore<0?selected:restore,direction);}
            int next=direction==NavCore.DOWN?-1:nextIn(scene,targets,selected,direction,FeedPolicy.DOCK);
            return new Plan(MOVE,next<0?selected:next,direction);
        }
        if(region==FeedPolicy.HEADER&&direction==NavCore.DOWN){
            int nextHeader=nextIn(scene,targets,selected,direction,FeedPolicy.HEADER);
            if(nextHeader>=0)return new Plan(MOVE,nextHeader,direction);
            int next=nearestIn(scene,targets,FeedPolicy.CONTENT,from.bounds.x(),scene.viewport.t);
            return next<0?new Plan(PASS,-1,direction):new Plan(MOVE,next,direction);
        }
        if(region!=FeedPolicy.CONTENT||direction==NavCore.LEFT||direction==NavCore.RIGHT)return new Plan(PASS,-1,direction);
        contentKey=from.key;
        if(scene.clipCandidate(from.id,from.bounds)==null)return new Plan(MOVE,restoreFocus(scene,targets),direction);
        int next=nextIn(scene,targets,selected,direction,FeedPolicy.CONTENT);
        if(next>=0)return new Plan(MOVE,next,direction);
        // Long-held directions continue browsing; only observed non-movement opens an edge exit.
        if(boundary(direction)){
            int to=nearestIn(scene,targets,direction==NavCore.DOWN?FeedPolicy.DOCK:FeedPolicy.HEADER,
                    from.bounds.x(),direction==NavCore.DOWN?scene.dock.t:scene.header.b);
            if(to>=0)return new Plan(MOVE,to,direction);
        }
        return new Plan(SWIPE,-1,direction);
    }
    public Attempt prepare(FeedPolicy.Scene scene,int direction,long inputGeneration){
        return scene==null||FeedPolicy.gesture(scene,direction)==null?null:new Attempt(scene,direction,inputGeneration);
    }
    /** Call only after KEY_UP and with a freshly collected scene; uses LIVE viewport bounds. */
    public FeedPolicy.Gesture resolve(Attempt attempt,FeedPolicy.Scene live,long inputGeneration,boolean keyHeld){
        if(attempt==null||keyHeld||attempt.generation!=inputGeneration||!attempt.before.sameScene(live))return null;
        return FeedPolicy.gesture(live,attempt.direction);
    }
    /** Capture at dispatch time, after refresh; never retain stale key-down geometry. */
    public Attempt atDispatch(Attempt planned,FeedPolicy.Scene live,long inputGeneration){
        return resolve(planned,live,inputGeneration,false)==null?null:prepare(live,planned.direction,inputGeneration);
    }
    /** Two unchanged, settled completed attempts are required before permitting boundary exit.
     * Rejection/cancellation, lost key-up, new input, stale window or one early frame do not count.
     */
    public void finish(Attempt attempt,Observation early,Observation late,boolean completed,long inputGeneration){
        if(attempt==null||attempt.finished||!completed||early==null||late==null||attempt.generation!=inputGeneration
                ||early.elapsedMs<250||late.elapsedMs<SETTLED_MS||late.elapsedMs-early.elapsedMs<200
                ||!attempt.before.sameScene(early.scene)||!attempt.before.sameScene(late.scene))return;
        attempt.finished=true;track(late.scene);
        if(attempt.before.signature!=early.scene.signature||attempt.before.signature!=late.scene.signature){failedUp=failedDown=0;return;}
        if(attempt.direction==NavCore.UP)failedUp++;else failedDown++;
    }
    public int unchangedAttempts(int direction){return direction==NavCore.UP?failedUp:failedDown;}
    /** Called after a completed gesture/settled refresh so vanished identities never select a dock. */
    public int restoreFocus(FeedPolicy.Scene scene,List<FeedPolicy.Target> targets){
        if(scene==null)return -1;
        return nearestIn(scene,targets,FeedPolicy.CONTENT,scene.viewport.x(),scene.viewport.y());
    }
}
