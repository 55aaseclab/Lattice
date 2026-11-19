// Determinism shim for the piper TTS child process (lattice M10/V2.0.25).
// onnxruntime (<=1.14) seeds its global RNG from system_clock::now() at
// library load; piper voice models carry RandomNormalLike nodes without a
// seed attribute, so per-run output bytes (and durations) vary. Freezing
// CLOCK_REALTIME inside the piper process pins that seed, making synthesis
// byte-deterministic for identical inputs. Piper itself does not need wall
// time. Loaded via LD_PRELOAD by the lattice piper adapter only.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <time.h>
#include <stdint.h>

typedef int (*clock_gettime_fn)(clockid_t, struct timespec *);

static long long frozen_realtime_ns(void) {
  // 2026-01-01T00:00:00Z, a fixed instant far from any load-time boundary.
  return 1767225600000000000LL;
}

int clock_gettime(clockid_t clk, struct timespec *tp) {
  static clock_gettime_fn real = NULL;
  if (clk == CLOCK_REALTIME || clk == CLOCK_REALTIME_COARSE) {
    long long ns = frozen_realtime_ns();
    tp->tv_sec = (time_t)(ns / 1000000000LL);
    tp->tv_nsec = (long)(ns % 1000000000LL);
    return 0;
  }
  if (!real) real = (clock_gettime_fn)dlsym(RTLD_NEXT, "clock_gettime");
  return real(clk, tp);
}
