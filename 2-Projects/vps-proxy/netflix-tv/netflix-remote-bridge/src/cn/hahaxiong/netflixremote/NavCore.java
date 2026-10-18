package cn.hahaxiong.netflixremote;

import java.util.List;

/** Geometry only, intentionally Android-free so real layout samples can be replayed. */
public final class NavCore {
    public static final int LEFT=0, RIGHT=1, UP=2, DOWN=3;
    public static final class Box {
        public final int l,t,r,b;
        public Box(int l,int t,int r,int b) { this.l=l;this.t=t;this.r=r;this.b=b; }
        public double x(){return (l+r)/2.0;} public double y(){return (t+b)/2.0;}
        public int width(){return r-l;} public int height(){return b-t;}
        public boolean valid(){return r>l&&b>t;}
    }
    public static Box clip(Box a, Box b) {
        Box c=new Box(Math.max(a.l,b.l),Math.max(a.t,b.t),Math.min(a.r,b.r),Math.min(a.b,b.b));
        return c.valid()?c:null;
    }
    public static boolean aligned(Box a,Box b,int d) {
        return d==LEFT||d==RIGHT ? Math.min(a.b,b.b)>Math.max(a.t,b.t) : Math.min(a.r,b.r)>Math.max(a.l,b.l);
    }
    public static int next(List<Box> boxes,int selected,int direction) {
        if(selected<0||selected>=boxes.size()) return initial(boxes);
        Box from=boxes.get(selected); int best=-1; double bestScore=Double.MAX_VALUE;
        for(int i=0;i<boxes.size();i++) {
            if(i==selected)continue;
            double score=score(from,boxes.get(i),direction);
            if(score<bestScore){bestScore=score;best=i;}
        }
        return best;
    }
    static double score(Box a,Box b,int d) {
        if(!b.valid())return Double.MAX_VALUE;
        double primary,minor; boolean beam;
        if(d==LEFT||d==RIGHT){
            primary=(b.x()-a.x())*(d==RIGHT?1:-1); minor=Math.abs(b.y()-a.y());
            beam=aligned(a,b,d);
        }else{
            primary=(b.y()-a.y())*(d==DOWN?1:-1); minor=Math.abs(b.x()-a.x());
            beam=aligned(a,b,d);
        }
        if(primary<2)return Double.MAX_VALUE;
        // Aligned row/column wins over diagonal, then distance. No wraparound.
        return (beam?0:1.0e10)+primary*primary+minor*minor*4;
    }
    public static int initial(List<Box> boxes) {
        int best=-1;double v=Double.MAX_VALUE;
        for(int i=0;i<boxes.size();i++){
            Box b=boxes.get(i);if(!b.valid())continue;
            double s=b.t*100000.0+b.l;if(s<v){v=s;best=i;}
        }return best;
    }
    public static int nearest(List<Box> boxes,Box target) {
        int best=-1;double v=Double.MAX_VALUE;
        for(int i=0;i<boxes.size();i++){
            Box b=boxes.get(i);double dx=b.x()-target.x(),dy=b.y()-target.y();double s=dx*dx+dy*dy;
            if(s<v){v=s;best=i;}
        }return best;
    }
}
