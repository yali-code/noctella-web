// Offline synthetic diagnostic only; not linked into the API.
#define _POSIX_C_SOURCE 200809L
#include <webp/encode.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <time.h>
static int write_bytes(const uint8_t *data, size_t size, const WebPPicture *picture) {
  return fwrite(data, 1, size, (FILE *)picture->custom_ptr) == size;
}
int main(int argc, char **argv) {
  if (argc != 4 || (strcmp(argv[1], "0") && strcmp(argv[1], "1")) ||
      strcmp(argv[2], "/codec/input.rgb") || strcmp(argv[3], "/codec/output.webp")) return 2;
  FILE *limit = fopen("/sys/fs/cgroup/memory.max", "r");
  long long bytes = 0, swap = -1;
  if (!limit || fscanf(limit, "%lld", &bytes) != 1) return 3;
  fclose(limit); limit = fopen("/sys/fs/cgroup/memory.swap.max", "r");
  if (!limit || fscanf(limit, "%lld", &swap) != 1) return 3;
  fclose(limit); if (bytes != 536870912 || swap != 0) return 3;
  struct stat input_stat;
  if (lstat(argv[2], &input_stat) || !S_ISREG(input_stat.st_mode) || input_stat.st_size != 72000000) return 4;
  FILE *input = fopen(argv[2], "rb");
  uint8_t *rgb = malloc(72000000);
  if (!input || !rgb || fread(rgb, 1, 72000000, input) != 72000000) return 5;
  fclose(input);
  WebPConfig config; WebPPicture picture;
  if (!WebPConfigPreset(&config, WEBP_PRESET_DEFAULT, 86) || !WebPPictureInit(&picture)) return 6;
  config.method = 4; config.alpha_quality = 100; config.target_size = 0; config.pass = 1;
  config.low_memory = atoi(argv[1]);
  if (!WebPValidateConfig(&config)) return 7;
  picture.width = 6000; picture.height = 4000; picture.use_argb = 0;
  if (!WebPPictureImportRGB(&picture, rgb, 18000)) return 8;
  free(rgb);
  FILE *output = fopen(argv[3], "wbx");
  if (!output) return 9;
  picture.writer = write_bytes; picture.custom_ptr = output;
  struct timespec start, end; clock_gettime(CLOCK_MONOTONIC, &start);
  int ok = WebPEncode(&config, &picture);
  clock_gettime(CLOCK_MONOTONIC, &end);
  int encoder_error = picture.error_code;
  WebPPictureFree(&picture);
  int close_ok = fclose(output) == 0;
  struct rusage usage; if (getrusage(RUSAGE_SELF, &usage)) return 10;
  printf("{\"diagnosticOnly\":true,\"libwebpVersion\":%d,\"lowMemory\":%d,\"quality\":86,\"method\":4,\"width\":6000,\"height\":4000,\"rssHwmBytes\":%ld,\"seconds\":%.6f,\"encoderError\":%d,\"ok\":%s}\n", WebPGetEncoderVersion(), config.low_memory, usage.ru_maxrss * 1024L, (end.tv_sec-start.tv_sec)+(end.tv_nsec-start.tv_nsec)/1e9, encoder_error, ok && close_ok ? "true" : "false");
  return ok && close_ok ? 0 : 11;
}
