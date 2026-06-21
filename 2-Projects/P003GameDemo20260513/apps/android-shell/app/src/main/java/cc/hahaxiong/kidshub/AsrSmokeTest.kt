package cc.hahaxiong.kidshub

import android.content.res.AssetManager
import android.content.Context
import android.os.Debug
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import com.k2fsa.sherpa.onnx.OnlineZipformer2CtcModelConfig
import com.k2fsa.sherpa.onnx.WaveData
import com.k2fsa.sherpa.onnx.WaveReader
import kotlin.concurrent.thread
import kotlin.system.measureTimeMillis

/**
 * P0 端侧 ASR smoke 验证（docs/32 §11.F · team 四发一致的 P0 硬门槛）
 *
 * 仅 debug build 启动时自动跑一次（后台线程，不阻塞 UI）。验三件事：
 *  1. 单一 libsherpa-onnx-jni.so 能否实例化 OnlineRecognizer —— 即 .so 真含 ASR 能力（非只 KWS）。
 *     若不含，会在 newFromAsset 抛错被 catch（= P0 不通过，整方案需换 sherpa 包，代码不必白写）。
 *  2. 同进程 KeywordSpotter(KWS) + OnlineRecognizer(ASR) 能否共存 init —— 为 P1 AudioEngine 单 .so 复用铺路。
 *  3. type9(transducer 14M 2023, ~30MB) vs type15(small-ctc 2025, ~25MB) 对 test wav 的识别文本 / RTF / 耗时 / 内存。
 *
 * 川哥真机：装 debug APK → `adb logcat -s AsrSmoke:*` 看结果。
 * 童声 CER：把 assets/asr-test.wav 换成真实 5-10 岁童声录音（16k mono wav）再装一次即可对比两模型。
 */
object AsrSmokeTest {
    private const val TAG = "AsrSmoke"

    fun run(context: Context) {
        val am = context.assets
        thread(name = "asr-smoke", isDaemon = true) {
            try {
                Log.i(TAG, "==================== P0 ASR SMOKE 开始 ====================")
                logMem("基线")

                val wave = WaveReader.readWave(am, "asr-test.wav")
                val audioSec = if (wave.sampleRate > 0) wave.samples.size.toFloat() / wave.sampleRate else 0f
                Log.i(TAG, "test wav: ${wave.samples.size} samples @ ${wave.sampleRate}Hz = ${"%.2f".format(audioSec)}s")

                runRecognizer("type9-transducer-14M-2023", am, transducerConfig(), wave, audioSec)
                runRecognizer("type15-small-ctc-2025", am, ctcConfig(), wave, audioSec)

                verifyCoexist(am)

                logMem("结束")
                Log.i(TAG, "==================== P0 ASR SMOKE 完成 ====================")
            } catch (e: Throwable) {
                Log.e(TAG, "P0 SMOKE 整体失败（.so 不含 ASR / 模型缺失 / wav 读取失败？）", e)
            }
        }
    }

    /** 跑一个 OnlineRecognizer：init + 喂 test wav + inputFinished flush + 出文本，记 RTF/耗时/内存 */
    private fun runRecognizer(
        label: String,
        am: AssetManager,
        config: OnlineRecognizerConfig,
        wave: WaveData,
        audioSec: Float,
    ) {
        Log.i(TAG, "---- [$label] ----")
        var rec: OnlineRecognizer? = null
        try {
            val initMs = measureTimeMillis { rec = OnlineRecognizer(assetManager = am, config = config) }
            val r = rec ?: throw IllegalStateException("OnlineRecognizer 为 null")
            val stream = r.createStream()
            val procMs = measureTimeMillis {
                stream.acceptWaveform(wave.samples, wave.sampleRate)
                // 0.5s 静音 padding + inputFinished：让 encoder flush 出完整尾部结果（离线喂单 wav 必需）
                stream.acceptWaveform(FloatArray(wave.sampleRate / 2), wave.sampleRate)
                stream.inputFinished()
                while (r.isReady(stream)) r.decode(stream)
            }
            val text = r.getResult(stream).text
            val rtf = if (audioSec > 0) procMs / 1000f / audioSec else -1f
            Log.i(TAG, "[$label] ✓ init=${initMs}ms decode=${procMs}ms RTF=${"%.3f".format(rtf)}")
            Log.i(TAG, "[$label] 识别结果=「$text」")
            stream.release()
            logMem("$label 驻留")
        } catch (e: Throwable) {
            Log.e(TAG, "[$label] ✗ 失败", e)
        } finally {
            rec?.release()
        }
    }

    /** 关键：单 .so 同进程 KWS + ASR 双实例共存 init（验 P1 AudioEngine 复用单 .so 的前提） */
    private fun verifyCoexist(am: AssetManager) {
        Log.i(TAG, "---- 单 .so 同进程 KWS + ASR 共存验证 ----")
        var kws: KeywordSpotter? = null
        var asr: OnlineRecognizer? = null
        try {
            kws = KeywordSpotter(assetManager = am, config = kwsConfig())
            asr = OnlineRecognizer(assetManager = am, config = transducerConfig())
            Log.i(TAG, "✓ KeywordSpotter + OnlineRecognizer 同进程共存 init 成功（单 .so 同时支撑 KWS+ASR）")
            logMem("KWS+ASR 双实例驻留")
        } catch (e: Throwable) {
            Log.e(TAG, "✗ KWS+ASR 共存失败", e)
        } finally {
            kws?.release()
            asr?.release()
        }
    }

    private fun transducerConfig() = OnlineRecognizerConfig(
        featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
        modelConfig = OnlineModelConfig(
            transducer = OnlineTransducerModelConfig(
                encoder = "asr-model-v9/encoder-epoch-99-avg-1.int8.onnx",
                decoder = "asr-model-v9/decoder-epoch-99-avg-1.onnx",
                joiner = "asr-model-v9/joiner-epoch-99-avg-1.int8.onnx",
            ),
            tokens = "asr-model-v9/tokens.txt",
            modelType = "zipformer",
            numThreads = 2,
            provider = "cpu",
        ),
        enableEndpoint = true,
    )

    private fun ctcConfig() = OnlineRecognizerConfig(
        featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
        modelConfig = OnlineModelConfig(
            zipformer2Ctc = OnlineZipformer2CtcModelConfig(
                model = "asr-model-v15/model.int8.onnx",
            ),
            tokens = "asr-model-v15/tokens.txt",
            numThreads = 2,
            provider = "cpu",
        ),
        enableEndpoint = true,
    )

    /** 复用 WakeWordBridge 的唤醒模型配置（kws-model/，现有） */
    private fun kwsConfig() = KeywordSpotterConfig(
        featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
        modelConfig = OnlineModelConfig(
            transducer = OnlineTransducerModelConfig(
                encoder = "kws-model/encoder.onnx",
                decoder = "kws-model/decoder.onnx",
                joiner = "kws-model/joiner.onnx",
            ),
            tokens = "kws-model/tokens.txt",
            modelType = "zipformer2",
            numThreads = 1,
            provider = "cpu",
        ),
        keywordsFile = "kws-model/keywords.txt",
        keywordsThreshold = 0.2f,
        keywordsScore = 2.0f,
    )

    private fun logMem(phase: String) {
        val rt = Runtime.getRuntime()
        val javaUsedMb = (rt.totalMemory() - rt.freeMemory()) / 1048576
        val nativeUsedMb = Debug.getNativeHeapAllocatedSize() / 1048576
        Log.i(TAG, "[mem/$phase] java=${javaUsedMb}MB native=${nativeUsedMb}MB")
    }
}
