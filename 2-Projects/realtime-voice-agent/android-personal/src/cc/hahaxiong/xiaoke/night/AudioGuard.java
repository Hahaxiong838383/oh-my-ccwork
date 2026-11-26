package cc.hahaxiong.xiaoke.night;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;

/** WebView owns playback focus. A second focus request from this Activity would
 * interrupt the same app when its remote WebRTC audio element starts playing. */
final class AudioGuard {
    private final AudioManager audio;
    private boolean active, previousSpeaker;
    private int previousMode;
    private boolean selectedSpeaker;

    AudioGuard(Context context) {
        audio = context.getSystemService(AudioManager.class);
    }
    void enterCall() {
        if (audio == null || active) return;
        previousMode = audio.getMode();
        previousSpeaker = audio.isSpeakerphoneOn();
        active = true;
        try {
            audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo route = audio.getCommunicationDevice();
                if (route == null || route.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
                    for (AudioDeviceInfo d : audio.getAvailableCommunicationDevices()) {
                        if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                            selectedSpeaker = audio.setCommunicationDevice(d);
                            break;
                        }
                    }
                }
            } else if (!audio.isBluetoothScoOn() && !audio.isWiredHeadsetOn()) {
                audio.setSpeakerphoneOn(true);
                selectedSpeaker = true;
            }
        } catch (RuntimeException ignored) { }
    }
    void exitCall() {
        if (!active || audio == null) return;
        active = false;
        try {
            if (selectedSpeaker && Build.VERSION.SDK_INT >= 31) {
                // Release our selection. Re-selecting the prior system route here
                // would give our process an active request after the call ends.
                audio.clearCommunicationDevice();
            } else if (selectedSpeaker) {
                audio.setSpeakerphoneOn(previousSpeaker);
            }
        } catch (RuntimeException ignored) { }
        try { audio.setMode(previousMode); } catch (RuntimeException ignored) { }
        selectedSpeaker = false;
    }
}
