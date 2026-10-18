package cn.hahaxiong.netflixremote;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.io.FileDescriptor;
import java.io.PrintWriter;

public class BridgeService extends AccessibilityService implements SharedPreferences.OnSharedPreferenceChangeListener {
    private static final String TARGET="com.netflix.mediaclient",TAG="NetflixRemoteBridge";
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final KeyState keys=new KeyState();
    private final List<Candidate> candidates=new ArrayList<>();
    private final List<AccessibilityNodeInfo> scrollables=new ArrayList<>();
    private SharedPreferences prefs; private WindowManager wm; private FocusOverlay overlay;
    private boolean enabled=true,player=false,controls=false,choiceMenu=false,editable=false,refreshQueued=false;
    private int selected=-1; private long lastRepeat,lastReveal; private int generation=0;
    private Rect playerBounds; private String selectedKey="",lastFocusLog="";private Rect selectedBounds;
    private AccessibilityNodeInfo playerNode;
    private Runnable pendingKeyUpAction;
    private int gestureSequence;
    private final LocalFeedInput localFeedInput=new LocalFeedInput();
    private final FeedNavigator feedNavigator=new FeedNavigator();
    private FeedPolicy.Scene feedScene;
    private boolean feedSwipePending;private int feedSequence,feedRunningSequence=-1;
    private final SeekPolicy.Draft seekDraft=new SeekPolicy.Draft();
    private int seekWindow=-1,seekGeneration=-1,playerTitleHash;
    private final Runnable refreshRunnable=()->{refreshQueued=false;refresh();};

    private static final class Candidate {
        final AccessibilityNodeInfo node;final Rect rect;final String id,key;
        Candidate(AccessibilityNodeInfo n,Rect r,String label){node=AccessibilityNodeInfo.obtain(n);rect=new Rect(r);id=s(n.getViewIdResourceName());key=id+"|"+(SeekPolicy.isSeekbarId(id)?"":label)+"|"+s(n.getClassName());}
    }
    private static String s(CharSequence c){return c==null?"":c.toString();}
    private static boolean tag(String id,String ending){return id.equals(ending)||id.endsWith("/"+ending);}
    private static boolean isControl(String id){return PlayerPolicy.isControl(id);}

    @Override protected void onServiceConnected(){
        prefs=getSharedPreferences("bridge",MODE_PRIVATE);enabled=prefs.getBoolean("enabled",true);prefs.registerOnSharedPreferenceChangeListener(this);
        wm=(WindowManager)getSystemService(WINDOW_SERVICE);Log.i(TAG,"connected version=0.1.8 enabled="+enabled);queueRefresh(0);
    }
    @Override public void onSharedPreferenceChanged(SharedPreferences p,String key){if("enabled".equals(key)){enabled=p.getBoolean(key,true);generation++;if(!enabled)clearScene();else queueRefresh(0);}}
    @Override public void onAccessibilityEvent(AccessibilityEvent event){
        if(event.getEventType()==AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED){generation++;pendingKeyUpAction=null;localFeedInput.cancel();cancelSeek();}
        if(event.getEventType()==AccessibilityEvent.TYPE_WINDOWS_CHANGED){
            AccessibilityNodeInfo active=netflixRoot();
            if(active==null){clearScene();return;}
            if(feedScene!=null&&active.getWindowId()!=feedScene.windowId){generation++;pendingKeyUpAction=null;resetFeed();cancelSeek();}
            active.recycle();
        }
        queueRefresh(90);
    }
    @Override public void onInterrupt(){clearScene();}
    @Override public void onDestroy(){handler.removeCallbacksAndMessages(null);if(prefs!=null)prefs.unregisterOnSharedPreferenceChangeListener(this);clearScene();super.onDestroy();}
    private void queueRefresh(long delay){if(refreshQueued)handler.removeCallbacks(refreshRunnable);refreshQueued=true;handler.postDelayed(refreshRunnable,delay);}

    private AccessibilityNodeInfo netflixRoot(){
        if(!enabled)return null;
        AccessibilityNodeInfo root=getRootInActiveWindow();
        if(root==null)return null;
        if(!TARGET.contentEquals(s(root.getPackageName()))){root.recycle();return null;}
        // Never steal navigation from an input method, permission panel, or another foreground window.
        for(AccessibilityWindowInfo w:getWindows()){
            if(w.getType()==AccessibilityWindowInfo.TYPE_INPUT_METHOD){root.recycle();return null;}
        }
        return root;
    }
    private void releaseNodes(){for(Candidate c:candidates)c.node.recycle();candidates.clear();for(AccessibilityNodeInfo n:scrollables)n.recycle();scrollables.clear();if(playerNode!=null){playerNode.recycle();playerNode=null;}}
    private void clearScene(){generation++;cancelSeek();resetFeed();releaseNodes();pendingKeyUpAction=null;keys.clear();selected=-1;selectedKey="";selectedBounds=null;player=false;controls=false;choiceMenu=false;playerBounds=null;hideOverlay();logFocus("focus index=-1 bounds=none id=none scene=inactive");}
    private List<NavCore.Box> boxes(){List<NavCore.Box> out=new ArrayList<>();for(Candidate c:candidates)out.add(box(c.rect));return out;}
    private static NavCore.Box box(Rect r){return new NavCore.Box(r.left,r.top,r.right,r.bottom);}

    private boolean refresh(){
        AccessibilityNodeInfo root=netflixRoot();
        if(root==null){clearScene();return false;}
        FeedPolicy.Scene previousFeed=feedScene;
        int previousTitle=playerTitleHash;playerTitleHash=0;
        releaseNodes();player=false;controls=false;choiceMenu=false;editable=false;playerBounds=null;
        Rect screen=wm.getMaximumWindowMetrics().getBounds();
        AccessibilityNodeInfo focus=root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if(focus!=null){editable=focus.isEditable();focus.recycle();}
        int windowId=root.getWindowId();collect(root,screen);
        List<FeedPolicy.Node> feedNodes=new ArrayList<>();snapshotFeed(root,"0",0,feedNodes);
        feedScene=FeedPolicy.detect(feedNodes,box(screen),windowId,player||choiceMenu||editable);root.recycle();
        if(previousFeed!=null&&!previousFeed.sameScene(feedScene)){localFeedInput.cancel();feedNavigator.reset();feedSwipePending=false;feedSequence++;pendingKeyUpAction=null;}
        if(feedScene!=null){
            for(int i=candidates.size()-1;i>=0;i--){Candidate c=candidates.get(i);NavCore.Box clipped=feedScene.clipCandidate(c.id,box(c.rect));if(clipped==null)candidates.remove(i).node.recycle();else c.rect.set(rect(clipped));}
            if(previousFeed==null){selectedKey="";selectedBounds=null;}
        }else feedNavigator.reset();
        if(player&&playerTitleHash==0)playerTitleHash=previousTitle;
        if(previousTitle!=0&&playerTitleHash!=0&&previousTitle!=playerTitleHash){generation++;pendingKeyUpAction=null;localFeedInput.cancel();cancelSeek();}
        if(seekDraft.active()&&(!player||choiceMenu||editable||windowId!=seekWindow||generation!=seekGeneration))cancelSeek();
        if(editable){hideOverlay();selected=-1;logFocus("focus index=-1 bounds=none id=none scene=editable");return false;}
        // A subtitle/speed choice panel may share PlayerActivity with its player underneath.
        // A real choice group takes precedence; a lone My List toggle does not hide Play.
        if(choiceMenu){for(int i=candidates.size()-1;i>=0;i--)if(isControl(candidates.get(i).id)){candidates.remove(i).node.recycle();}}
        selected=findSaved();
        if(selected<0)selected=defaultSelection();
        // During seek/loading Netflix may expose only Back. Keep the intended key for recovery,
        // but never turn that transient node into an actionable selection.
        if(player&&!choiceMenu&&controls&&!hasTransportCandidate())selected=-1;
        if(seekDraft.active()){int index=findId("seekbar");if(index>=0&&!seekDraft.matches(seekRange(candidates.get(index).node)))cancelSeek();}
        rememberAndDraw();return true;
    }
    private void collect(AccessibilityNodeInfo root,Rect screen){
        CandidateTree.collect(root,box(screen),new CandidateTree.Adapter<AccessibilityNodeInfo>(){
            public NavCore.Box bounds(AccessibilityNodeInfo n){Rect r=new Rect();n.getBoundsInScreen(r);return box(r);}
            public boolean visible(AccessibilityNodeInfo n){return n.isVisibleToUser();}
            public boolean clipsChildren(AccessibilityNodeInfo n){return n.isScrollable();}
            public int childCount(AccessibilityNodeInfo n){return n.getChildCount();}
            public AccessibilityNodeInfo child(AccessibilityNodeInfo n,int i){return n.getChild(i);}
            public void release(AccessibilityNodeInfo n){n.recycle();}
        },new CandidateTree.Visitor<AccessibilityNodeInfo>(){
            public void visible(AccessibilityNodeInfo node,NavCore.Box bounds){
                String id=s(node.getViewIdResourceName());Rect visible=rect(bounds);
                if(tag(id,"playerTopBarTitleTestTag"))playerTitleHash=label(node,0).hashCode();
                if(tag(id,"playerTappableContainerTestTag")){player=true;playerBounds=visible;if(playerNode!=null)playerNode.recycle();playerNode=AccessibilityNodeInfo.obtain(node);}
                if(node.isEnabled()&&PlayerPolicy.actionableControl(id,node.isClickable(),hasAction(node,AccessibilityNodeInfo.ACTION_CLICK))){player=true;controls=true;}
                if(isSeekNode(node)){player=true;controls=true;}
                if(isChoiceGroup(node,bounds))choiceMenu=true;
                if(node.isScrollable())scrollables.add(AccessibilityNodeInfo.obtain(node));
            }
            public boolean keep(AccessibilityNodeInfo node,NavCore.Box bounds,int descendants){
                String id=s(node.getViewIdResourceName());
                if(tag(id,"playerTappableContainerTestTag")||candidates.size()>=500)return false;
                if(isSeekNode(node))return true;
                List<String> children=new ArrayList<>();
                for(int i=0;i<node.getChildCount();i++){AccessibilityNodeInfo child=node.getChild(i);if(child!=null){children.add(s(child.getViewIdResourceName()));child.recycle();}}
                return NodePolicy.keep(node.isEnabled(),node.isClickable()||hasAction(node,AccessibilityNodeInfo.ACTION_CLICK),node.isCheckable(),node.isEditable(),isControl(id),descendants,NodePolicy.continueWatchingCard(id,children));
            }
            public void candidate(AccessibilityNodeInfo node,NavCore.Box bounds){
                String label=label(node,0),id=s(node.getViewIdResourceName()),key=id+"|"+label+"|"+s(node.getClassName());Rect visible=rect(bounds);
                for(Candidate c:candidates)if(c.rect.equals(visible)&&c.key.equals(key))return;
                candidates.add(new Candidate(node,visible,label));
            }
        });
    }
    private static Rect rect(NavCore.Box b){return new Rect(b.l,b.t,b.r,b.b);}
    private boolean isChoiceGroup(AccessibilityNodeInfo parent,NavCore.Box bounds){
        boolean radio=parent.isEnabled()&&parent.isCheckable()&&s(parent.getClassName()).endsWith("RadioButton");
        List<NavCore.Box> choices=new ArrayList<>();
        for(int i=0;i<parent.getChildCount();i++){
            AccessibilityNodeInfo child=parent.getChild(i);if(child==null)continue;
            if(child.isVisibleToUser()&&child.isEnabled()&&child.isCheckable()){
                Rect raw=new Rect();child.getBoundsInScreen(raw);NavCore.Box visible=NavCore.clip(box(raw),bounds);
                if(visible!=null&&visible.width()>=4&&visible.height()>=4){choices.add(visible);radio|=s(child.getClassName()).endsWith("RadioButton");}
            }
            child.recycle();
        }
        return NodePolicy.choiceGroup(choices,radio);
    }
    private String label(AccessibilityNodeInfo n,int depth){
        String own=s(n.getContentDescription())+" "+s(n.getText());if(!own.trim().isEmpty())return own.trim();
        if(depth>3)return "";StringBuilder b=new StringBuilder();
        for(int i=0;i<n.getChildCount()&&b.length()<100;i++){AccessibilityNodeInfo c=n.getChild(i);if(c!=null){b.append(label(c,depth+1)).append(' ');c.recycle();}}
        return b.toString().trim();
    }
    private int findSaved(){
        return findCandidate(selectedKey,selectedBounds);
    }
    private int findCandidate(String key,Rect origin){
        int found=-1;double best=Double.MAX_VALUE;
        for(int i=0;i<candidates.size();i++){
            Candidate c=candidates.get(i);if(!c.key.equals(key))continue;
            double d=origin==null?0:Math.pow(c.rect.centerX()-origin.centerX(),2)+Math.pow(c.rect.centerY()-origin.centerY(),2);
            if(d<best){best=d;found=i;}
        }return found;
    }
    private int defaultSelection(){
        if(player&&!choiceMenu){int p=findId("pauseButtonTestTag");if(p<0)p=findId("playButtonTestTag");if(p<0)p=findId("playPauseButtonTestTag");return p;}
        if(feedScene!=null)return feedNavigator.restoreFocus(feedScene,feedTargets());
        for(int i=0;i<candidates.size();i++)if(candidates.get(i).node.isFocused())return i;
        return NavCore.initial(boxes());
    }
    private int findId(String id){for(int i=0;i<candidates.size();i++)if(tag(candidates.get(i).id,id))return i;return -1;}
    private void rememberAndDraw(){
        if(selected<0||selected>=candidates.size()){hideOverlay();logFocus("focus index=-1 bounds=none id=none scene="+scene());return;}
        Candidate c=candidates.get(selected);selectedKey=c.key;selectedBounds=new Rect(c.rect);showOverlay(c.rect);
        logFocus("focus index="+selected+" count="+candidates.size()+" bounds="+c.rect.toShortString()+" id="+c.id+" scene="+scene());
    }
    private boolean hasTransportCandidate(){for(Candidate c:candidates)if(PlayerPolicy.isTransport(c.id))return true;return false;}
    private boolean waitingForPlayer(){return PlayerPolicy.waitForControls(player,choiceMenu,controls,hasTransportCandidate(),selected);}
    private String scene(){return choiceMenu?"choice_menu":waitingForPlayer()?"player_waiting":player?"player":feedScene!=null?"new_hot_feed":"navigation";}
    private void logFocus(String line){if(!line.equals(lastFocusLog)){lastFocusLog=line;Log.i(TAG,line);}}

    @Override protected boolean onKeyEvent(KeyEvent event){
        int code=event.getKeyCode();
        boolean direction=code==KeyEvent.KEYCODE_DPAD_LEFT||code==KeyEvent.KEYCODE_DPAD_RIGHT||code==KeyEvent.KEYCODE_DPAD_UP||code==KeyEvent.KEYCODE_DPAD_DOWN;
        boolean ok=code==KeyEvent.KEYCODE_DPAD_CENTER||code==KeyEvent.KEYCODE_ENTER||code==KeyEvent.KEYCODE_NUMPAD_ENTER;
        boolean back=code==KeyEvent.KEYCODE_BACK;
        int press=(event.getDeviceId()<<16)^code;
        if(!direction&&!ok&&!back){invalidateForNativeKey(event,press);return false;}
        if(event.getAction()==KeyEvent.ACTION_UP){
            boolean handled=keys.release(press);
            if(!keys.hasPressed(SystemClock.uptimeMillis())&&pendingKeyUpAction!=null){Runnable action=pendingKeyUpAction;pendingKeyUpAction=null;handler.postDelayed(action,50);}
            return handled;
        }
        if(event.getAction()!=KeyEvent.ACTION_DOWN)return false;
        if(back&&!seekDraft.active()){if(keys.owns(press,SystemClock.uptimeMillis())){keys.down(press,SystemClock.uptimeMillis(),true);return true;}invalidateForNativeKey(event,press);return false;}
        keys.down(press,SystemClock.uptimeMillis(),event.getRepeatCount()>0);
        if(event.getRepeatCount()==0){pendingKeyUpAction=null;localFeedInput.cancel();feedSwipePending=false;feedSequence++;}
        if(!refresh())return false;
        if(back){if(!seekDraft.active())return false;keys.consume(press,SystemClock.uptimeMillis());cancelSeek();rememberAndDraw();Log.i(TAG,"seek_preview cancelled=back");return true;}
        if(seekDraft.active()&&(code==KeyEvent.KEYCODE_DPAD_UP||code==KeyEvent.KEYCODE_DPAD_DOWN))cancelSeek();
        if(waitingForPlayer()){
            keys.consume(press,SystemClock.uptimeMillis());
            if(event.getRepeatCount()==0)Log.i(TAG,"wait_player_controls key="+code);
            return true;
        }
        int dir=code==KeyEvent.KEYCODE_DPAD_LEFT?NavCore.LEFT:code==KeyEvent.KEYCODE_DPAD_RIGHT?NavCore.RIGHT:code==KeyEvent.KEYCODE_DPAD_UP?NavCore.UP:NavCore.DOWN;
        boolean canReveal=player&&!choiceMenu&&!controls&&playerBounds!=null;
        if(selected<0&&!canReveal){
            // Unknown/empty Netflix pages retain their native key handling. A scroll-only page
            // is consumed only when the requested action actually succeeds.
            boolean scrolled=direction&&!scrollables.isEmpty()&&scroll(dir);
            if(scrolled)keys.consume(press,SystemClock.uptimeMillis());
            else Log.i(TAG,"passthrough reason=no_actionable_target key="+code);
            return scrolled;
        }
        keys.consume(press,SystemClock.uptimeMillis());
        long now=SystemClock.uptimeMillis();
        if(event.getRepeatCount()>0&&(ok||now-lastRepeat<160))return true;
        lastRepeat=now;
        long seekHeldMs=keys.heldDuration(press,now);
        String selectedId=selected>=0?candidates.get(selected).id:"";
        if(seekDraft.active()&&player&&!choiceMenu&&!controls){
            if(code==KeyEvent.KEYCODE_DPAD_LEFT||code==KeyEvent.KEYCODE_DPAD_RIGHT){seekDraft.adjust(code==KeyEvent.KEYCODE_DPAD_RIGHT?1:-1,seekHeldMs);Log.i(TAG,"seek_preview hidden=true targetMs="+seekDraft.target()+" heldMs="+seekHeldMs+" stepMs="+SeekPolicy.stepMs(seekHeldMs));}
            reveal(null);return true;
        }
        if(selected>=0&&isSeekNode(candidates.get(selected).node)&&player&&!choiceMenu){
            if(code==KeyEvent.KEYCODE_DPAD_LEFT||code==KeyEvent.KEYCODE_DPAD_RIGHT){previewSeek(code==KeyEvent.KEYCODE_DPAD_RIGHT?1:-1,seekHeldMs);return true;}
            if(ok){commitSeek();return true;}
            if(direction)cancelSeek();
        }else if(seekDraft.active())cancelSeek();
        if(PlayerPolicy.seekKeys(player,choiceMenu,controls,selectedId)&&direction&&(code==KeyEvent.KEYCODE_DPAD_LEFT||code==KeyEvent.KEYCODE_DPAD_RIGHT)){
            String seek=code==KeyEvent.KEYCODE_DPAD_LEFT?"backwardSeekButtonTestTag":"forwardSeekButtonTestTag";
            int index=findId(seek);
            if(index>=0){click(index);return true;}
            if(!controls&&playerBounds!=null){reveal(seek);return true;}
        }
        if(player&&!choiceMenu&&!controls&&playerBounds!=null){reveal(null);return true;}
        if(ok){if(selected>=0)click(selected);return true;}
        if(feedScene!=null){
            FeedNavigator.Plan plan=feedNavigator.plan(feedScene,feedTargets(),selected,dir,event.getEventTime()-event.getDownTime());
            if(plan.action==FeedNavigator.MOVE){pendingKeyUpAction=null;localFeedInput.cancel();feedSwipePending=false;feedSequence++;if(plan.index>=0){selected=plan.index;rememberAndDraw();}return true;}
            if(plan.action==FeedNavigator.SWIPE){if(feedRunningSequence<0&&!scroll(dir))queueFeedSwipe(dir);return true;}
        }
        int next=NavCore.next(boxes(),selected,dir);
        if(selected>=0&&next>=0&&!NavCore.aligned(box(candidates.get(selected).rect),box(candidates.get(next).rect),dir)&&scroll(dir))return true;
        if(next>=0){selected=next;rememberAndDraw();Log.i(TAG,"navigate count="+candidates.size()+" direction="+dir);}
        else scroll(dir);
        return true;
    }
    /** Native BACK/HOME/volume still pass through, but a new input supersedes queued mutations. */
    private void invalidateForNativeKey(KeyEvent event,int press){
        if(event.getAction()!=KeyEvent.ACTION_DOWN||event.getRepeatCount()!=0)return;
        keys.down(press,SystemClock.uptimeMillis(),false);localFeedInput.cancel();pendingKeyUpAction=null;feedSwipePending=false;feedSequence++;
    }
    private static int nodeIdentity(AccessibilityNodeInfo node){return (s(node.getText())+"|"+s(node.getContentDescription())).hashCode();}
    private void snapshotFeed(AccessibilityNodeInfo node,String path,int depth,List<FeedPolicy.Node> out){
        if(depth>45||out.size()>=2000)return;String id=s(node.getViewIdResourceName());Rect bounds=new Rect();node.getBoundsInScreen(bounds);
        out.add(new FeedPolicy.Node(path,id,box(bounds),node.isVisibleToUser(),node.isEnabled()&&(node.isClickable()||hasAction(node,AccessibilityNodeInfo.ACTION_CLICK)),node.isCheckable(),node.isChecked(),tag(id,"2131427665")&&"New & Hot".equals(s(node.getText())),nodeIdentity(node)));
        for(int i=0;i<node.getChildCount()&&out.size()<2000;i++){AccessibilityNodeInfo child=node.getChild(i);if(child==null)continue;try{snapshotFeed(child,path+"/"+i,depth+1,out);}finally{child.recycle();}}
    }
    private List<FeedPolicy.Target> feedTargets(){List<FeedPolicy.Target> out=new ArrayList<>();for(Candidate c:candidates)out.add(new FeedPolicy.Target(c.key,c.id,box(c.rect)));return out;}
    private void resetFeed(){localFeedInput.cancel();feedScene=null;feedNavigator.reset();feedSwipePending=false;feedSequence++;feedRunningSequence=-1;}
    private boolean feedIntentCurrent(FeedNavigator.Attempt attempt,int sceneToken,int sequence){
        return sequence==feedSequence&&sceneToken==generation&&keys.current(attempt.generation,SystemClock.uptimeMillis())&&foregroundWindowMatches(attempt.before.windowId);
    }
    private void queueFeedSwipe(int direction){
        final FeedNavigator.Attempt planned=feedNavigator.prepare(feedScene,direction,keys.generation());if(planned==null)return;
        final int sceneToken=generation,sequence=++feedSequence;feedSwipePending=true;
        afterKeyUp(()->{
            if(!feedIntentCurrent(planned,sceneToken,sequence)||!refresh()||!feedIntentCurrent(planned,sceneToken,sequence)||feedScene==null)return;
            if(selected<0||feedScene.region(candidates.get(selected).id,box(candidates.get(selected).rect))!=FeedPolicy.CONTENT){feedSwipePending=false;return;}
            FeedPolicy.Gesture gesture=feedNavigator.resolve(planned,feedScene,keys.generation(),keys.hasPressed(SystemClock.uptimeMillis()));
            final FeedNavigator.Attempt dispatched=feedNavigator.atDispatch(planned,feedScene,keys.generation());
            if(gesture==null||dispatched==null){feedSwipePending=false;return;}
            Path path=new Path();path.moveTo(gesture.x,gesture.startY);path.lineTo(gesture.x,gesture.endY);
            feedRunningSequence=sequence;
            boolean accepted=dispatchGesture(new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(path,0,gesture.durationMs)).build(),new GestureResultCallback(){
                @Override public void onCompleted(GestureDescription description){
                    if(feedRunningSequence==sequence)feedRunningSequence=-1;
                    if(!feedIntentCurrent(dispatched,sceneToken,sequence))return;
                    Log.i(TAG,"feed_swipe sequence="+sequence+" completed=true");
                    observeFeedCompletion(dispatched,sceneToken,sequence);
                }
                @Override public void onCancelled(GestureDescription description){
                    if(feedRunningSequence==sequence)feedRunningSequence=-1;
                    Log.i(TAG,"feed_swipe sequence="+sequence+" cancelled=true");
                    if(feedIntentCurrent(dispatched,sceneToken,sequence))startLocalFeedFallback(dispatched,sceneToken,sequence);else if(sequence==feedSequence)feedSwipePending=false;
                }
            },handler);
            if(!accepted){feedSwipePending=false;if(feedRunningSequence==sequence)feedRunningSequence=-1;}
            Log.i(TAG,"feed_swipe sequence="+sequence+" accepted="+accepted+" direction="+direction+" viewport="+rect(feedScene.viewport).toShortString());
        });
    }
    private void observeFeedCompletion(FeedNavigator.Attempt dispatched,int sceneToken,int sequence){
                    final long completedAt=SystemClock.uptimeMillis();final FeedNavigator.Observation[] early={null};
                    handler.postDelayed(()->{
                        if(!feedIntentCurrent(dispatched,sceneToken,sequence)||!refresh()||!feedIntentCurrent(dispatched,sceneToken,sequence)||!dispatched.before.sameScene(feedScene))return;
                        early[0]=new FeedNavigator.Observation(feedScene,SystemClock.uptimeMillis()-completedAt);
                        int next=feedNavigator.restoreFocus(feedScene,feedTargets());if(next>=0){selected=next;rememberAndDraw();}
                    },350);
                    handler.postDelayed(()->{
                        if(!feedIntentCurrent(dispatched,sceneToken,sequence)||!refresh()||!feedIntentCurrent(dispatched,sceneToken,sequence)||!dispatched.before.sameScene(feedScene))return;
                        FeedNavigator.Observation late=new FeedNavigator.Observation(feedScene,SystemClock.uptimeMillis()-completedAt);
                        feedNavigator.finish(dispatched,early[0],late,true,keys.generation());feedSwipePending=false;
                        int next=feedNavigator.restoreFocus(feedScene,feedTargets());if(next>=0){selected=next;rememberAndDraw();}
                        Log.i(TAG,"feed_settled signature="+feedScene.signature+" unchangedUp="+feedNavigator.unchangedAttempts(NavCore.UP)+" unchangedDown="+feedNavigator.unchangedAttempts(NavCore.DOWN));
                    },950);
    }
    private void startLocalFeedFallback(FeedNavigator.Attempt cancelled,int sceneToken,int sequence){
        if(!feedIntentCurrent(cancelled,sceneToken,sequence)||keys.hasPressed(SystemClock.uptimeMillis())||!refresh()||!feedIntentCurrent(cancelled,sceneToken,sequence)||feedScene==null){feedSwipePending=false;return;}
        if(selected<0||feedScene.region(candidates.get(selected).id,box(candidates.get(selected).rect))!=FeedPolicy.CONTENT){feedSwipePending=false;return;}
        FeedPolicy.Gesture gesture=feedNavigator.resolve(cancelled,feedScene,keys.generation(),false);
        final FeedNavigator.Attempt actual=feedNavigator.atDispatch(cancelled,feedScene,keys.generation());
        if(gesture==null||actual==null){feedSwipePending=false;return;}
        feedRunningSequence=sequence;feedSwipePending=true;
        Log.i(TAG,"feed_local_fallback sequence="+sequence+" start=true viewport="+rect(feedScene.viewport).toShortString());
        localFeedInput.start(getCacheDir(),gesture,android.os.Process.myPid(),(success,reason)->handler.post(()->{
            if(feedRunningSequence==sequence)feedRunningSequence=-1;
            Log.i(TAG,"feed_local_fallback sequence="+sequence+" completed="+success+" reason="+reason);
            if(!feedIntentCurrent(actual,sceneToken,sequence))return;
            if(success)observeFeedCompletion(actual,sceneToken,sequence);else feedSwipePending=false;
        }));
    }
    private static SeekPolicy.Range seekRange(AccessibilityNodeInfo node){
        AccessibilityNodeInfo.RangeInfo range=node.getRangeInfo();
        return range==null?null:new SeekPolicy.Range(range.getMin(),range.getMax(),range.getCurrent());
    }
    private static boolean isSeekNode(AccessibilityNodeInfo node){
        return node.isEnabled()&&SeekPolicy.seekbar(s(node.getViewIdResourceName()),seekRange(node),hasAction(node,AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_PROGRESS.getId()));
    }
    private void cancelSeek(){seekDraft.cancel();seekWindow=-1;seekGeneration=-1;}
    private void previewSeek(int direction,long heldMs){
        Candidate c=candidates.get(selected);SeekPolicy.Range range=seekRange(c.node);
        if(!SeekPolicy.valid(range))return;
        seekWindow=c.node.getWindowId();seekGeneration=generation;
        seekDraft.preview(range,direction,heldMs);rememberAndDraw();
        Log.i(TAG,"seek_preview targetMs="+seekDraft.target()+" heldMs="+heldMs+" stepMs="+SeekPolicy.stepMs(heldMs));
    }
    private void commitSeek(){
        if(!seekDraft.active()){rememberAndDraw();return;}
        final float target=seekDraft.target();final int windowId=seekWindow,sceneToken=seekGeneration;
        afterKeyUp(()->{
            if(!foregroundWindowMatches(windowId)||!refresh()||generation!=sceneToken||!player||choiceMenu||!seekDraft.active())return;
            int index=findId("seekbar");if(index<0)return;
            Candidate c=candidates.get(index);
            if(!c.node.refresh()||!c.node.isVisibleToUser()||!isSeekNode(c.node)||!seekDraft.matches(seekRange(c.node)))return;
            Bundle arguments=new Bundle();arguments.putFloat(AccessibilityNodeInfo.ACTION_ARGUMENT_PROGRESS_VALUE,target);
            boolean accepted=c.node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_PROGRESS.getId(),arguments);
            Log.i(TAG,"seek_commit targetMs="+target+" semantic="+accepted);
            if(accepted)cancelSeek();selected=index;rememberAndDraw();queueRefresh(180);
        });
    }
    private void click(int index){
        if(index<0||index>=candidates.size())return;
        if(isSeekNode(candidates.get(index).node)){selected=index;rememberAndDraw();commitSeek();return;}
        Candidate c=candidates.get(index);selected=index;rememberAndDraw();
        if(!foregroundWindowMatches(c.node.getWindowId())||!c.node.refresh()||!c.node.isVisibleToUser()||!c.node.isEnabled()){queueRefresh(0);return;}
        Rect liveForClick=liveVisibleBounds(c.node);if(liveForClick==null){queueRefresh(0);return;}c.rect.set(liveForClick);
        // An already selected radio item may deliberately be non-clickable.
        if(c.node.isCheckable()&&c.node.isChecked()&&!c.node.isClickable()){Log.i(TAG,"already_selected");return;}
        boolean done=c.node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        Log.i(TAG,"click id="+c.id+" semantic="+done);
        if(!done){
            String targetKey=c.key;Rect origin=new Rect(c.rect);int windowId=c.node.getWindowId(),sceneToken=generation;
            afterKeyUp(()->{
                // Re-resolve after the key is released; no stale node handle or coordinates survive the delay.
                if(!foregroundWindowMatches(windowId)||!refresh()||generation!=sceneToken)return;
                int current=findCandidate(targetKey,origin);if(current<0){Log.i(TAG,"gesture_skipped reason=target_gone");return;}
                Candidate liveCandidate=candidates.get(current);Rect live=liveVisibleBounds(liveCandidate.node);
                if(live!=null&&foregroundWindowMatches(windowId)){
                    selected=current;liveCandidate.rect.set(live);rememberAndDraw();
                    Log.i(TAG,"gesture_fallback id="+liveCandidate.id+" bounds="+live.toShortString());
                    tap(live.centerX(),live.centerY(),null);
                }else Log.i(TAG,"gesture_skipped reason=stale_or_invisible");
            });
        }
        queueRefresh(180);
    }
    private boolean foregroundWindowMatches(int windowId){
        AccessibilityNodeInfo root=netflixRoot();if(root==null)return false;
        boolean same=root.getWindowId()==windowId;root.recycle();return same;
    }
    private Rect liveVisibleBounds(AccessibilityNodeInfo node){
        if(!node.refresh()||!node.isVisibleToUser()||!node.isEnabled())return null;
        Rect visible=new Rect();node.getBoundsInScreen(visible);
        if(!visible.intersect(wm.getMaximumWindowMetrics().getBounds()))return null;
        AccessibilityNodeInfo parent=node.getParent();int depth=0;boolean valid=true;
        while(parent!=null&&depth++<45){
            if(parent.isScrollable()){
                Rect viewport=new Rect();parent.getBoundsInScreen(viewport);
                if(!visible.intersect(viewport))valid=false;
            }
            AccessibilityNodeInfo next=parent.getParent();parent.recycle();parent=next;
        }
        if(parent!=null)parent.recycle();
        if(!valid||visible.width()<4||visible.height()<4)return null;
        if(feedScene!=null){NavCore.Box clipped=feedScene.clipCandidate(s(node.getViewIdResourceName()),box(visible));return clipped==null?null:rect(clipped);}
        return visible;
    }
    private void reveal(String pendingSeek){
        long now=SystemClock.uptimeMillis();if(now-lastReveal<600)return;lastReveal=now;
        long ticket=keys.generation();final int sceneToken=generation;
        if(playerNode==null)return;int windowId=playerNode.getWindowId();
        if(!foregroundWindowMatches(windowId)||!playerNode.refresh()||!playerNode.isVisibleToUser())return;
        boolean done=playerNode.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        Log.i(TAG,"reveal_player_controls semantic="+done);
        if(done){afterReveal(pendingSeek,windowId,ticket,sceneToken);return;}
        afterKeyUp(()->{
            if(!foregroundWindowMatches(windowId)||!refresh()||generation!=sceneToken||choiceMenu||playerNode==null)return;
            if(controls){Log.i(TAG,"gesture_skipped reason=controls_already_visible");afterReveal(pendingSeek,windowId,ticket,sceneToken);return;}
            Rect live=liveVisibleBounds(playerNode);
            if(live==null||!foregroundWindowMatches(windowId))return;
            tap(live.centerX(),live.centerY(),()->afterReveal(pendingSeek,windowId,ticket,sceneToken));
        });
    }
    private void afterReveal(String pendingSeek,int windowId,long ticket,int sceneToken){
        handler.postDelayed(()->{
            if(!keys.current(ticket,SystemClock.uptimeMillis()))return;
            if(!foregroundWindowMatches(windowId)||!refresh()||generation!=sceneToken||choiceMenu)return;
            if(pendingSeek!=null){int idx=findId(pendingSeek);if(idx>=0)click(idx);}
        },220);
    }
    private void afterKeyUp(Runnable action){
        final long ticket=keys.generation();final int sceneToken=generation;
        Runnable guarded=()->{
            long now=SystemClock.uptimeMillis();
            if(generation!=sceneToken||!keys.current(ticket,now)||keys.hasPressed(now)){Log.i(TAG,"gesture_skipped reason=new_key_or_orphan");return;}
            action.run();
        };
        if(keys.hasPressed(SystemClock.uptimeMillis())){
            pendingKeyUpAction=guarded;Log.i(TAG,"gesture_queued reason=key_down");
            handler.postDelayed(()->{if(pendingKeyUpAction==guarded&&!keys.current(ticket,SystemClock.uptimeMillis()))pendingKeyUpAction=null;},5500);
        }else handler.postDelayed(guarded,50);
    }
    private boolean tap(float x,float y,Runnable completed){
        AccessibilityNodeInfo root=netflixRoot();if(root==null)return false;root.recycle();
        Path path=new Path();path.moveTo(x,y);
        final int sequence=++gestureSequence;
        boolean accepted=dispatchGesture(new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(path,0,80)).build(),new GestureResultCallback(){
            @Override public void onCompleted(GestureDescription gesture){Log.i(TAG,"gesture sequence="+sequence+" completed=true");queueRefresh(80);if(completed!=null)completed.run();}
            @Override public void onCancelled(GestureDescription gesture){Log.i(TAG,"gesture sequence="+sequence+" cancelled=true");queueRefresh(80);}
        },handler);
        Log.i(TAG,"gesture sequence="+sequence+" accepted="+accepted+" x="+x+" y="+y);return accepted;
    }
    private static boolean hasAction(AccessibilityNodeInfo n,int id){for(AccessibilityNodeInfo.AccessibilityAction a:n.getActionList())if(a.getId()==id)return true;return false;}
    private boolean scroll(int direction){
        int action=direction==NavCore.LEFT?AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.getId():direction==NavCore.RIGHT?AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.getId():direction==NavCore.UP?AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.getId():AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.getId();
        // Nearest scroll ancestor first, preserving nested carousel/list ownership.
        List<AccessibilityNodeInfo> ordered=new ArrayList<>();
        if(selected>=0){AccessibilityNodeInfo p=candidates.get(selected).node.getParent();int depth=0;while(p!=null&&depth++<45){if(p.isScrollable())ordered.add(AccessibilityNodeInfo.obtain(p));AccessibilityNodeInfo parent=p.getParent();p.recycle();p=parent;}if(p!=null)p.recycle();}
        if(ordered.isEmpty())for(AccessibilityNodeInfo n:scrollables)ordered.add(AccessibilityNodeInfo.obtain(n));
        boolean done=false;
        for(AccessibilityNodeInfo n:ordered){
            if(!done&&hasAction(n,action))done=n.performAction(action);
            if(!done){
                Rect r=new Rect();n.getBoundsInScreen(r);String cls=s(n.getClassName()).toLowerCase(Locale.ROOT);
                boolean horizontal=cls.contains("horizontal")||r.width()>r.height()*2;
                boolean requestedHorizontal=direction==NavCore.LEFT||direction==NavCore.RIGHT;
                if(horizontal==requestedHorizontal){int generic=(direction==NavCore.RIGHT||direction==NavCore.DOWN)?AccessibilityNodeInfo.ACTION_SCROLL_FORWARD:AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD;if(hasAction(n,generic))done=n.performAction(generic);}
            }
            n.recycle();
        }
        if(done){Log.i(TAG,"scroll direction="+direction);queueRefresh(220);}
        return done;
    }

    /** Read-only diagnostics; deliberately never print node text/contentDescription/action labels. */
    @Override protected void dump(FileDescriptor fd,PrintWriter writer,String[] args){
        boolean fresh=false;for(String arg:args)if("--refresh-nodes".equals(arg))fresh=true;
        writer.println("NetflixRemoteBridge version=0.1.8 enabled="+enabled+" scene="+scene()+" player="+player+" controls="+controls+" transportPresent="+hasTransportCandidate()+" choiceMenu="+choiceMenu+" editable="+editable+" pendingKeyUp="+(pendingKeyUpAction!=null)+" heldKeys="+keys.size(SystemClock.uptimeMillis())+" heldDurationMaxMs="+keys.longestHeldDuration(SystemClock.uptimeMillis()));
        writer.println("feedLocalBusy="+localFeedInput.busy()+" feedLocalRootProbePassed="+localFeedInput.rootVerified()+" feedLocalLastResult="+localFeedInput.lastResult());
        writer.println("feedRecognized="+(feedScene!=null)+" feedSignature="+(feedScene==null?0:feedScene.signature)+" feedViewport="+(feedScene==null?"none":rect(feedScene.viewport).toShortString())+" feedSwipePending="+feedSwipePending+" feedGestureRunning="+(feedRunningSequence>=0)+" unchangedUp="+feedNavigator.unchangedAttempts(NavCore.UP)+" unchangedDown="+feedNavigator.unchangedAttempts(NavCore.DOWN));
        writer.println("seekEditing="+seekDraft.active()+" seekTargetMs="+(seekDraft.active()?seekDraft.target():-1)+" sceneGeneration="+generation);
        writer.println("selected="+selected+" candidates="+candidates.size()+" scrollables="+scrollables.size()+" playerBounds="+(playerBounds==null?"none":playerBounds.toShortString()));
        for(int i=0;i<candidates.size();i++){
            Candidate c=candidates.get(i);
            writer.println("candidate index="+i+" selected="+(i==selected)+" id="+c.id+" snapshotBounds="+c.rect.toShortString());
        }
        AccessibilityNodeInfo root=netflixRoot();
        if(root==null){writer.println("root=unavailable (disabled, non-Netflix foreground, or IME)");return;}
        writer.println("rootWindow="+root.getWindowId()+" refreshNodes="+fresh+" maxNodes=600");
        int[] count={0};dumpNode(writer,root,"0",0,count,fresh);root.recycle();
        writer.println("nodesPrinted="+count[0]+" truncated="+(count[0]>=600));
    }
    private void dumpNode(PrintWriter writer,AccessibilityNodeInfo node,String path,int depth,int[] count,boolean fresh){
        if(depth>45||count[0]>=600)return;count[0]++;
        boolean refreshed=!fresh||node.refresh();Rect bounds=new Rect();node.getBoundsInScreen(bounds);
        StringBuilder actions=new StringBuilder("[");
        for(AccessibilityNodeInfo.AccessibilityAction action:node.getActionList()){
            if(actions.length()>1)actions.append(',');actions.append(action.getId());
        }
        actions.append(']');
        writer.println("node path="+path+" id="+s(node.getViewIdResourceName())+" class="+s(node.getClassName())+" range="+rangeSummary(node)+(tag(s(node.getViewIdResourceName()),"2131429420")?" identityHash="+nodeIdentity(node):"")+" bounds="+bounds.toShortString()+" visible="+node.isVisibleToUser()+" clickable="+node.isClickable()+" checkable="+node.isCheckable()+" checked="+node.isChecked()+" editable="+node.isEditable()+" enabled="+node.isEnabled()+" scrollable="+node.isScrollable()+" refreshed="+refreshed+" actions="+actions);
        for(int i=0;i<node.getChildCount()&&count[0]<600;i++){
            AccessibilityNodeInfo child=node.getChild(i);if(child==null)continue;
            dumpNode(writer,child,path+"/"+i,depth+1,count,fresh);child.recycle();
        }
    }

    private static String rangeSummary(AccessibilityNodeInfo node){
        AccessibilityNodeInfo.RangeInfo range=node.getRangeInfo();
        if(range==null)return "none";
        return "[type="+range.getType()+",min="+range.getMin()+",max="+range.getMax()+",current="+range.getCurrent()+"]";
    }
    private void showOverlay(Rect target){
        if(overlay==null){
            overlay=new FocusOverlay();
            WindowManager.LayoutParams p=new WindowManager.LayoutParams(WindowManager.LayoutParams.MATCH_PARENT,WindowManager.LayoutParams.MATCH_PARENT,WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE|WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE|WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN|WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,PixelFormat.TRANSLUCENT);
            p.gravity=Gravity.TOP|Gravity.LEFT;p.setTitle("Netflix remote focus");
            try{wm.addView(overlay,p);}catch(RuntimeException ex){overlay=null;Log.w(TAG,"overlay unavailable "+ex.getClass().getSimpleName());return;}
        }
        overlay.rect.set(target);overlay.seekFraction=-1;overlay.seekLabel="";
        if(selected>=0&&selected<candidates.size()&&isSeekNode(candidates.get(selected).node)){
            SeekPolicy.Range range=seekRange(candidates.get(selected).node);float value=seekDraft.active()?seekDraft.target():range.current;
            overlay.seekFraction=SeekPolicy.fraction(range,value);
            overlay.seekLabel=SeekPolicy.formatMs(value)+" / "+SeekPolicy.formatMs(range.max)+(seekDraft.active()?"   OK 跳转 · 返回取消":"   ← / → 调整进度");
        }
        overlay.invalidate();
    }
    private void hideOverlay(){if(overlay!=null){try{wm.removeView(overlay);}catch(RuntimeException ignored){}overlay=null;}}
    private final class FocusOverlay extends View {
        float seekFraction=-1;String seekLabel="";
        final Rect rect=new Rect();final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
        FocusOverlay(){super(BridgeService.this);setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);setFocusable(false);paint.setStyle(Paint.Style.STROKE);}
        @Override protected void onDraw(Canvas canvas){super.onDraw(canvas);int[] origin=new int[2];getLocationOnScreen(origin);Rect r=new Rect(rect);r.offset(-origin[0],-origin[1]);float scale=getResources().getDisplayMetrics().density;paint.setStyle(Paint.Style.STROKE);paint.setColor(Color.BLACK);paint.setStrokeWidth(7*scale);canvas.drawRoundRect(r.left,r.top,r.right,r.bottom,10*scale,10*scale,paint);paint.setColor(Color.rgb(0,205,255));paint.setStrokeWidth(4*scale);canvas.drawRoundRect(r.left,r.top,r.right,r.bottom,10*scale,10*scale,paint);
            if(seekFraction>=0){
                float x=r.left+seekFraction*r.width();paint.setColor(Color.WHITE);paint.setStrokeWidth(5*scale);canvas.drawLine(x,r.top-8*scale,x,r.bottom+8*scale,paint);
                paint.setTextSize(20*scale);float width=paint.measureText(seekLabel),pad=10*scale;
                float left=Math.max(pad,Math.min(r.left,getWidth()-width-3*pad)),bottom=Math.max(36*scale,r.top-12*scale);
                paint.setStyle(Paint.Style.FILL);paint.setColor(Color.argb(225,0,0,0));canvas.drawRoundRect(left-pad,bottom-28*scale,left+width+pad,bottom+6*scale,5*scale,5*scale,paint);
                paint.setColor(Color.WHITE);canvas.drawText(seekLabel,left,bottom,paint);
            }
        }
    }
}
