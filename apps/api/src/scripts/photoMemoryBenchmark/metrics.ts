/**
 * P2-1 (#373): process memory sampling for the photo memory benchmark.
 *
 * process.resourceUsage().maxRSS is the OS-reported peak resident set (peak
 * working set on Windows) for the whole process, so it includes native
 * libvips/Sharp allocations and short spikes. heapUsed / external /
 * arrayBuffers are only observable by polling, so their peaks are sampled
 * and can miss spikes shorter than the sampling interval.
 */

export interface MemorySnapshot {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

export interface MemoryPeaks extends MemorySnapshot {
  samples: number;
}

export function snapshot(): MemorySnapshot {
  const { rss, heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
  return { rss, heapUsed, heapTotal, external, arrayBuffers };
}

export function maxRssBytes(): number {
  // Node reports maxRSS in kilobytes.
  return process.resourceUsage().maxRSS * 1024;
}

export function mergePeak(peak: MemoryPeaks, sample: MemorySnapshot): MemoryPeaks {
  return {
    rss: Math.max(peak.rss, sample.rss),
    heapUsed: Math.max(peak.heapUsed, sample.heapUsed),
    heapTotal: Math.max(peak.heapTotal, sample.heapTotal),
    external: Math.max(peak.external, sample.external),
    arrayBuffers: Math.max(peak.arrayBuffers, sample.arrayBuffers),
    samples: peak.samples + 1,
  };
}

export function startSampler(intervalMs = 5) {
  let peak: MemoryPeaks = { ...snapshot(), samples: 1 };
  const timer = setInterval(() => { peak = mergePeak(peak, snapshot()); }, intervalMs);
  return {
    stop(): MemoryPeaks {
      clearInterval(timer);
      peak = mergePeak(peak, snapshot());
      return peak;
    },
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function mib(bytes: number, digits = 1): string {
  return (bytes / (1024 * 1024)).toFixed(digits);
}
