package cn.hahaxiong.tvnetstatus;

import android.app.*;
import android.content.Context;
import android.content.Intent;
import android.graphics.*;
import android.graphics.drawable.GradientDrawable;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.*;
import android.provider.Settings;
import android.util.Log;
import android.view.*;
import android.widget.*;
import java.io.*;

public final class StatusService extends Service {
    private static final String TAG = "TvNetworkStatus";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final StatusModel model = new StatusModel();
    private WindowManager wm;
    private LinearLayout panel;
    private TextView title, subtitle, dot;
    private boolean attached, finished;
    private long started;
    private String lastTitle = "", lastSubtitle = "";
    private Context ui;
    private VirtualDisplay testDisplay;
    private ImageReader testReader;
    private boolean privateTest;
    private long readyDrawAt = -1;
    private final Runnable tick = new Runnable() {
        public void run() { update(); if (!finished) handler.postDelayed(this, 50); }
    };

    @Override public void onCreate() {
        super.onCreate(); started = SystemClock.elapsedRealtime();
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("boot", "开机联网", NotificationManager.IMPORTANCE_MIN));
        startForeground(1, new Notification.Builder(this, "boot")
                .setSmallIcon(android.R.drawable.stat_notify_sync).setContentTitle("正在准备电视网络")
                .setOngoing(true).setShowWhen(false).build());
        ui = this; wm = getSystemService(WindowManager.class);
        makePanel(); handler.post(tick);
    }

    @Override public int onStartCommand(Intent in, int flags, int id) {
        if (in == null) { finish(false); return START_NOT_STICKY; }
        // DUMP protects this diagnostic too; it draws to a bitmap, never a screen.
        if ("cn.hahaxiong.tvnetstatus.RENDER_PREVIEW".equals(in.getAction())) {
            renderPreview(); finish(false); return START_NOT_STICKY;
        }
        if ("cn.hahaxiong.tvnetstatus.PRIVATE_DISPLAY_TEST".equals(in.getAction())) {
            privateDisplayTest(); return START_NOT_STICKY;
        }
        String boot = in.getStringExtra("boot");
        if (boot != null && boot.equals(getSharedPreferences("state", 0).getString("completed", ""))) {
            finish(false); return START_NOT_STICKY;
        }
        boolean accepted = model.accept(boot, in.getStringExtra("phase"),
                in.getBooleanExtra("home", false), in.getBooleanExtra("ready", false),
                in.getLongExtra("seq", -1), SystemClock.elapsedRealtime());
        if (accepted && !model.home && !model.ready) finish(false);
        else if (accepted) update();
        else Log.i(TAG, "ignored_invalid_or_stale_state");
        return START_NOT_STICKY;
    }

    private int dp(int n) { return Math.round(n * ui.getResources().getDisplayMetrics().density); }
    private TextView text(float size, int color) {
        TextView t = new TextView(ui); t.setTextSize(size); t.setTextColor(color);
        t.setSingleLine(true); t.setIncludeFontPadding(false); return t;
    }
    private void makePanel() {
        panel = new LinearLayout(ui); panel.setOrientation(LinearLayout.HORIZONTAL);
        panel.setGravity(Gravity.CENTER_VERTICAL); panel.setPadding(dp(16), dp(14), dp(16), dp(14));
        GradientDrawable bg = new GradientDrawable(); bg.setColor(0xEE17222E);
        bg.setCornerRadius(dp(12)); bg.setStroke(dp(1), 0x554F6578); panel.setBackground(bg);
        panel.setElevation(dp(6)); panel.setFocusable(false); panel.setClickable(false);
        dot = text(22, 0xFFFFC56A); dot.setText("●");
        panel.addView(dot, new LinearLayout.LayoutParams(dp(30), -2));
        LinearLayout words = new LinearLayout(ui); words.setOrientation(LinearLayout.VERTICAL);
        title = text(17, Color.WHITE); title.setTypeface(null, Typeface.BOLD);
        subtitle = text(12, 0xFFB9C7D4); subtitle.setPadding(0, dp(6), 0, 0);
        words.addView(title); words.addView(subtitle);
        panel.addView(words, new LinearLayout.LayoutParams(0, -2, 1));
    }
    private void labels(boolean ready, String name, long seconds) {
        if (!name.equals(lastTitle)) {
            title.setText(name); dot.setText(ready ? "✓" : "●");
            dot.setTextColor(ready ? 0xFF77E4B4 : 0xFFFFC56A); lastTitle=name;
        }
        String sub = ready ? "可以打开视频应用" :
                (seconds >= 90 ? "连接较慢，自动重试中 · " : "请稍候 · 开机 ") + seconds + " 秒";
        if (!sub.equals(lastSubtitle)) { subtitle.setText(sub); lastSubtitle=sub; }
    }
    private void update() {
        if (finished) return;
        long now = SystemClock.elapsedRealtime(); model.tick(now);
        if (model.done) { finish(true); return; }
        if (model.visible(now) && Settings.canDrawOverlays(this)) {
            labels(model.ready, model.title(), now / 1000);
            if (!attached) {
                WindowManager.LayoutParams lp = new WindowManager.LayoutParams(dp(276), -2,
                        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE |
                        WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE |
                        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL |
                        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                        PixelFormat.TRANSLUCENT);
                lp.gravity = Gravity.BOTTOM | Gravity.RIGHT; lp.x = dp(24); lp.y = dp(24);
                lp.setTitle("TvNetworkStatus"); lp.windowAnimations = 0;
                try { wm.addView(panel, lp); attached = true;
                    Log.i(TAG, "shown phase=" + model.phase + " elapsed=" + now);
                } catch (RuntimeException e) { Log.e(TAG, "overlay_attach_failed"); }
            }
            if (attached && model.ready) panel.postOnAnimation(new Runnable() {
                public void run() { if (attached && model.ready) {
                    long time=SystemClock.elapsedRealtime(); model.attached(time);
                    if (readyDrawAt < 0) { readyDrawAt=time; Log.i(TAG,"ready_drawn elapsed="+time); }
                } }
            });
        } else hide();
        // A dead watcher must not leave an immortal foreground service.
        if (model.abandoned(now) || (now - started > 20000 && model.boot.isEmpty())) finish(false);
    }
    private void hide() {
        if (!attached) return;
        wm.removeViewImmediate(panel); attached = false;
        Log.i(TAG, "hidden elapsed=" + SystemClock.elapsedRealtime());
    }
    private void finish(boolean complete) {
        if (finished) return; finished = true;
        if (complete && !privateTest) getSharedPreferences("state", 0).edit().putString("completed", model.boot).commit();
        if (complete && privateTest) {
            long duration=SystemClock.elapsedRealtime()-readyDrawAt;
            try (FileOutputStream out=openFileOutput("private-display-test.json", MODE_PRIVATE)) {
                out.write(("{\"display_id\":"+testDisplay.getDisplay().getDisplayId()+
                    ",\"success_visible_ms\":"+duration+",\"private_display\":true}").getBytes("UTF-8"));
            } catch (IOException e) { Log.e(TAG,"private_test_report_failed"); }
        }
        hide(); handler.removeCallbacks(tick); stopForeground(true); stopSelf();
        Log.i(TAG, "finished complete=" + complete + " elapsed=" + SystemClock.elapsedRealtime());
    }
    private void renderPreview() {
        try {
            for (boolean ready : new boolean[]{false, true}) {
                labels(ready, ready ? "网络已连接" : "正在完成网络准备…", 38);
                panel.measure(View.MeasureSpec.makeMeasureSpec(dp(276), View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
                panel.layout(0, 0, panel.getMeasuredWidth(), panel.getMeasuredHeight());
                Bitmap b = Bitmap.createBitmap(panel.getWidth(), panel.getHeight(), Bitmap.Config.ARGB_8888);
                panel.draw(new Canvas(b));
                try (FileOutputStream out = openFileOutput(ready ? "ready.png" : "waiting.png", MODE_PRIVATE)) {
                    b.compress(Bitmap.CompressFormat.PNG, 100, out);
                }
                b.recycle();
            }
            Log.i(TAG, "preview_rendered_offscreen");
        } catch (IOException e) { Log.e(TAG, "preview_failed"); }
    }
    private void privateDisplayTest() {
        // This diagnostic cannot draw on the physical display. Do not fall back.
        if (attached || !model.boot.isEmpty()) { finish(false); return; }
        privateTest=true;
        try {
            testReader=ImageReader.newInstance(1280,720,PixelFormat.RGBA_8888,2);
            testReader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                public void onImageAvailable(ImageReader reader) {
                    Image i=reader.acquireLatestImage(); if(i!=null) i.close();
                }
            },handler);
            testDisplay=getSystemService(DisplayManager.class).createVirtualDisplay("TvNetworkStatusTest",
                    1280,720,160,testReader.getSurface(),DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY);
            Display display=testDisplay.getDisplay();
            if (display.getDisplayId()==Display.DEFAULT_DISPLAY || (display.getFlags() & Display.FLAG_PRIVATE)==0)
                throw new IllegalStateException("Test display must be private and non-default");
            ui=createDisplayContext(display); wm=ui.getSystemService(WindowManager.class);
            makePanel();
            long now=SystemClock.elapsedRealtime();
            model.accept("00000000-0000-0000-0000-000000000001","cache",true,false,now,now);
            update();
            handler.postDelayed(new Runnable() { public void run() {
                long time=SystemClock.elapsedRealtime();
                model.accept(model.boot,"ready",true,true,time,time); update();
            } },1500);
            Log.i(TAG,"private_test_display="+display.getDisplayId());
        } catch (RuntimeException e) { Log.e(TAG,"private_test_failed "+e.getClass().getSimpleName()); finish(false); }
    }
    @Override public void onDestroy() {
        hide(); handler.removeCallbacksAndMessages(null);
        if(testDisplay!=null) testDisplay.release();
        if(testReader!=null) testReader.close();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent in) { return null; }
}
