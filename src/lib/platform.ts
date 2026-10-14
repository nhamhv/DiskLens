import { api } from "@/lib/api";
import type { PlatformFeatures } from "@/lib/types";

/** What this OS build supports. Loaded once before the first render (see main.tsx). */
export let platform: PlatformFeatures = {
  os: navigator.userAgent.includes("Mac") ? "macos" : "linux",
  apps: false,
  fullDiskAccess: false,
  hiddenSpace: false,
  quickLook: false,
  heic: false,
};

export async function loadPlatform() {
  platform = await api.platformFeatures();
}

export const isMac = () => platform.os === "macos";

/** "⌘S" on macOS, "Ctrl+S" elsewhere. */
export const shortcut = (key: string) => (isMac() ? `⌘${key}` : `Ctrl+${key}`);

/** i18n keys naming the system file manager. */
export const showInKey = () => (isMac() ? "common.showInFinder" : "common.showInFileManager");
export const openInKey = () => (isMac() ? "common.openInFinder" : "common.openInFileManager");
