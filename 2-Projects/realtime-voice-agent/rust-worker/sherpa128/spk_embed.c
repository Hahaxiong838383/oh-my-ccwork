/* 声纹 embedding 对撞探针(上线前置② S2,任务 tasks/voice-eot-上线前置.md)。
 *
 * 用途:用**链 ORT 1.28 的新构建** libsherpa-onnx-c-api.so 对一段 16k mono s16 wav
 * 算 speaker embedding,输出 dim + 原始浮点文本(一行一个,%.9g)。
 * 与 64.90 venv(sherpa 1.13.3 × ORT 1.24.4,生产现役路径)对同一 wav 的输出
 * 做余弦对撞(compare_embeddings.py),回答「换 ORT 版本是否改变 embedding」。
 *
 * 处理口径对齐 sidecar/eot_sidecar.py::_speaker_embed:
 *   i16 → f32 /32768 → accept_waveform(16000) → input_finished → compute。
 *   (L2 归一在对撞脚本做,本程序输出原始向量——归一前对撞更严格。)
 *
 * 用法: spk_embed <campplus.onnx> <wav_16k_s16_mono> */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sherpa-onnx/c-api/c-api.h"

/* 最小 RIFF 解析:找 "fmt " 验采样率/位深/声道,找 "data" 返回样本区。
 * 不猜 44 字节头——probe/外来 wav 可能带 LIST 等扩展 chunk。 */
static int16_t *read_wav_16k_mono(const char *path, int32_t *n_samples) {
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "open %s failed\n", path); return NULL; }
  char id[4]; uint32_t sz, riff_type;
  if (fread(id, 1, 4, f) != 4 || memcmp(id, "RIFF", 4) ||
      fread(&sz, 4, 1, f) != 1 || fread(&riff_type, 4, 1, f) != 1 ||
      memcmp(&riff_type, "WAVE", 4)) {
    fprintf(stderr, "not a RIFF/WAVE file\n"); fclose(f); return NULL;
  }
  int fmt_ok = 0; int16_t *data = NULL;
  while (fread(id, 1, 4, f) == 4 && fread(&sz, 4, 1, f) == 1) {
    if (!memcmp(id, "fmt ", 4)) {
      uint16_t audio_fmt, ch, bits; uint32_t rate;
      long pos = ftell(f);
      fread(&audio_fmt, 2, 1, f); fread(&ch, 2, 1, f);
      fread(&rate, 4, 1, f); fseek(f, 6, SEEK_CUR); fread(&bits, 2, 1, f);
      if (audio_fmt != 1 || ch != 1 || rate != 16000 || bits != 16) {
        fprintf(stderr, "expect PCM 16k mono s16, got fmt=%u ch=%u rate=%u bits=%u\n",
                audio_fmt, ch, rate, bits);
        fclose(f); return NULL;
      }
      fmt_ok = 1;
      fseek(f, pos + sz, SEEK_SET);
    } else if (!memcmp(id, "data", 4)) {
      if (!fmt_ok) { fprintf(stderr, "data before fmt\n"); fclose(f); return NULL; }
      data = (int16_t *)malloc(sz);
      if (fread(data, 1, sz, f) != sz) { fprintf(stderr, "short read\n"); free(data); fclose(f); return NULL; }
      *n_samples = (int32_t)(sz / 2);
      fclose(f);
      return data;
    } else {
      fseek(f, (long)sz + (sz & 1), SEEK_CUR); /* chunk 按 2 字节对齐 */
    }
  }
  fclose(f);
  fprintf(stderr, "no data chunk\n");
  return NULL;
}

int main(int argc, char **argv) {
  if (argc != 3) { fprintf(stderr, "usage: %s <model.onnx> <wav>\n", argv[0]); return 2; }

  int32_t n = 0;
  int16_t *pcm = read_wav_16k_mono(argv[2], &n);
  if (!pcm) return 1;

  float *samples = (float *)malloc(sizeof(float) * (size_t)n);
  for (int32_t i = 0; i < n; i++) samples[i] = (float)pcm[i] / 32768.0f;

  SherpaOnnxSpeakerEmbeddingExtractorConfig config;
  memset(&config, 0, sizeof(config));
  config.model = argv[1];
  config.num_threads = 1;
  config.debug = 0;
  config.provider = "cpu";

  const SherpaOnnxSpeakerEmbeddingExtractor *ex =
      SherpaOnnxCreateSpeakerEmbeddingExtractor(&config);
  if (!ex) { fprintf(stderr, "create extractor failed (model=%s)\n", argv[1]); return 1; }

  const SherpaOnnxOnlineStream *stream =
      SherpaOnnxSpeakerEmbeddingExtractorCreateStream(ex);
  SherpaOnnxOnlineStreamAcceptWaveform(stream, 16000, samples, n);
  SherpaOnnxOnlineStreamInputFinished(stream);
  if (!SherpaOnnxSpeakerEmbeddingExtractorIsReady(ex, stream)) {
    fprintf(stderr, "not enough audio for embedding (n=%d)\n", n);
    return 1;
  }
  const float *emb = SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding(ex, stream);
  int32_t dim = SherpaOnnxSpeakerEmbeddingExtractorDim(ex);

  printf("dim %d\n", dim);
  for (int32_t i = 0; i < dim; i++) printf("%.9g\n", emb[i]);

  SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding(emb);
  SherpaOnnxDestroyOnlineStream(stream);
  SherpaOnnxDestroySpeakerEmbeddingExtractor(ex);
  free(samples);
  free(pcm);
  return 0;
}
