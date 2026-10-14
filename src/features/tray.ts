import { defaultWindowIcon } from "@tauri-apps/api/app";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { getCurrentWindow } from "@tauri-apps/api/window";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import { formatBytes } from "@/lib/format";

const REFRESH_MS = 60_000;

/**
 * Menu bar (macOS) / tray (Linux) icon showing free space, with shortcuts to scan.
 * Built from JS so its labels follow the app language. Linux needs libayatana-appindicator;
 * without it this quietly does nothing. Returns a cleanup function.
 */
export async function setupTray(onScan: (path: string) => void, home: string): Promise<() => void> {
  const t = i18n.t;
  const show = async () => {
    const w = getCurrentWindow();
    await w.unminimize();
    await w.show();
    await w.setFocus();
  };
  const free = await MenuItem.new({ id: "free", text: "…", enabled: false });
  const menu = await Menu.new({
    items: [
      free,
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ id: "open", text: t("tray.open"), action: show }),
      await MenuItem.new({ id: "home", text: t("tray.scanHome"), action: () => show().then(() => onScan(home)) }),
      await MenuItem.new({ id: "disk", text: t("tray.scanDisk"), action: () => show().then(() => onScan("/")) }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ id: "quit", text: t("tray.quit"), action: () => api.quitApp() }),
    ],
  });
  const tray = await TrayIcon.new({
    // Unique, so a tray being replaced (language change, React strict mode) can't remove the new one.
    id: `disklens-${Date.now()}-${Math.random()}`,
    icon: (await defaultWindowIcon()) ?? undefined,
    tooltip: "DiskLens",
    menu,
    showMenuOnLeftClick: true,
  });
  const refresh = () =>
    api
      .diskInfo()
      .then(async (d) => {
        const text = t("tray.free", { free: formatBytes(d.free), total: formatBytes(d.total) });
        await free.setText(text);
        await tray.setTooltip(`DiskLens — ${text}`);
      })
      .catch(() => {});
  refresh();
  const timer = window.setInterval(refresh, REFRESH_MS);
  return () => {
    window.clearInterval(timer);
    tray.close().catch(() => {});
  };
}
