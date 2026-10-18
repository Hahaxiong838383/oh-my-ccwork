package cn.hahaxiong.netflixremote;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.provider.Settings;
import android.graphics.Color;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.TextView;

public class MainActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout=new LinearLayout(this);layout.setOrientation(1);layout.setPadding(48,36,48,36);
        TextView title=new TextView(this);title.setText("Netflix 遥控适配");title.setTextSize(28);layout.addView(title);
        TextView help=new TextView(this);help.setTextSize(18);help.setPadding(0,20,0,24);
        help.setText("只适配 Netflix。方向键选择蓝框按钮，OK 点击。HOME、音量保持原样；返回仅在进度预览时取消草稿。\n\n播放：主播放区域的左右键后退/前进 10 秒；按下选择进度条，左右预览目标时间（长按加速），OK 确认跳转，返回取消。再按下越过进度条进入底部菜单，用左右切换。控件隐藏时先按 OK 显示，再选择蓝框按钮并按 OK。\n\nNew & Hot：上下浏览预览，列表边缘继续按会滚动；只有确认到顶或到底后，继续按才进入标题栏或底栏。\n\n本应用不联网，不修改 Netflix 登录数据。首次使用需开启下方无障碍服务。");layout.addView(help);
        SharedPreferences prefs=getSharedPreferences("bridge",MODE_PRIVATE);
        Switch enabled=new Switch(this);enabled.setText("启用 Netflix 遥控适配");enabled.setTextSize(20);enabled.setChecked(prefs.getBoolean("enabled",true));
        enabled.setOnCheckedChangeListener((button,checked)->prefs.edit().putBoolean("enabled",checked).apply());layout.addView(enabled);
        Button access=new Button(this);access.setText("打开系统无障碍设置");access.setOnClickListener(v->startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));layout.addView(access);
        Button open=new Button(this);open.setText("打开 Netflix");open.setOnClickListener(v->{Intent i=getPackageManager().getLaunchIntentForPackage("com.netflix.mediaclient");if(i!=null)startActivity(i);});layout.addView(open);
        setContentView(layout);enabled.requestFocus();
    }
}
