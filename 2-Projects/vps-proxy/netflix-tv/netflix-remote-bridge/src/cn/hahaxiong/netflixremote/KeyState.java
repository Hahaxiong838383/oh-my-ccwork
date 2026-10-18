package cn.hahaxiong.netflixremote;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/** Input ownership and intent lifetime; a lost key-up must not become a permanent latch. */
public final class KeyState {
    private final Map<Integer,Long> pressed=new HashMap<>();
    private final Map<Integer,Long> heldSince=new HashMap<>();
    private long generation;
    public void down(int key,long now,boolean repeat){prune(now);if(!repeat)generation++;if(pressed.containsKey(key))pressed.put(key,now);}
    public void consume(int key,long now){prune(now);if(!pressed.containsKey(key))heldSince.put(key,now);pressed.put(key,now);}
    public boolean owns(int key,long now){prune(now);return pressed.containsKey(key);}
    public long heldDuration(int key,long now){prune(now);Long since=heldSince.get(key);return since==null?0:Math.max(0,now-since);}
    public long longestHeldDuration(long now){prune(now);long duration=0;for(long since:heldSince.values())duration=Math.max(duration,now-since);return duration;}
    public boolean release(int key){heldSince.remove(key);return pressed.remove(key)!=null;}
    public void clear(){pressed.clear();heldSince.clear();generation++;}
    public long generation(){return generation;}
    public boolean current(long ticket,long now){prune(now);return ticket==generation;}
    public boolean hasPressed(long now){prune(now);return !pressed.isEmpty();}
    public int size(long now){prune(now);return pressed.size();}
    private void prune(long now){
        boolean removed=false;Iterator<Map.Entry<Integer,Long>> iterator=pressed.entrySet().iterator();
        while(iterator.hasNext()){Map.Entry<Integer,Long> entry=iterator.next();if(now-entry.getValue()>5000){heldSince.remove(entry.getKey());iterator.remove();removed=true;}}
        if(removed)generation++; // Cancel an old delayed click instead of firing seconds later.
    }
}
