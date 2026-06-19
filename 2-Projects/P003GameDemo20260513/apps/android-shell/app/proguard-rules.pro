# 保留 JS Bridge 方法（addJavascriptInterface 反射调用）
-keepclassmembers class cc.hahaxiong.kidshub.WakeWordBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class cc.hahaxiong.kidshub.WakeWordBridge { *; }

# Porcupine 模型资源保留（按需）
-keep class ai.picovoice.porcupine.** { *; }
