import type { Platform } from "./types";

const LABELS: Record<Platform, string> = {
  WINDOWS: "Windows",
  LINUX: "Linux",
  MACOS: "macOS",
};

export function platformLabel(platform: Platform): string {
  return LABELS[platform];
}
