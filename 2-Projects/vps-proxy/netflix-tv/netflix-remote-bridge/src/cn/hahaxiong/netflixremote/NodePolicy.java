package cn.hahaxiong.netflixremote;

import java.util.List;

public final class NodePolicy {
    private static boolean id(String value,String number){return value.equals("com.netflix.mediaclient:id/"+number);}
    /** Observed 9.84 card: the parent's Play action is independent of its Info/More controls. */
    public static boolean continueWatchingCard(String parent,List<String> children){
        if(!id(parent,"2131427788"))return false;
        boolean info=false,more=false;
        for(String child:children){info|=id(child,"2131427786");more|=id(child,"2131427791");}
        return info&&more;
    }
    public static boolean keep(boolean enabled,boolean canClick,boolean checkable,boolean editable,boolean playerControl,int descendants,boolean independentAction){
        boolean actionable=enabled&&(canClick||(!playerControl&&(checkable||editable)));
        boolean wrapper=descendants>0&&!checkable&&!editable&&!independentAction;
        return actionable&&!wrapper;
    }
    /** A vertical group of choices or an explicit radio role; a single My List toggle is not a dialog. */
    public static boolean choiceGroup(List<NavCore.Box> choices,boolean radioRole){
        if(radioRole)return true;
        for(int i=0;i<choices.size();i++)for(int j=i+1;j<choices.size();j++){
            NavCore.Box a=choices.get(i),b=choices.get(j);
            int overlap=Math.min(a.r,b.r)-Math.max(a.l,b.l);
            if(overlap>=Math.min(a.width(),b.width())/2.0&&Math.abs(a.y()-b.y())>=Math.min(a.height(),b.height())/2.0)return true;
        }
        return false;
    }
}
