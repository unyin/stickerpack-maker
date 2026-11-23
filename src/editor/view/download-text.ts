// Message-line text for the background removal model download (SPM-7).
import type { DownloadProgress } from "../api";

/** Bytes as whole megabytes (10^6, as download sizes are usually shown). */
export function megabytes(bytes: number): string {
  return `${Math.max(0, Math.round(bytes / 1e6))} MB`;
}

/** The message line while the model downloads. */
export function downloadProgressText(p: DownloadProgress): string {
  const percent = p.total > 0 ? Math.min(100, Math.floor((p.received / p.total) * 100)) : 0;
  return `Downloading the background removal model: ${percent}% (${Math.round(p.received / 1e6)} of ${megabytes(p.total)})…`;
}
