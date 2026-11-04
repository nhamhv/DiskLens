import { useEffect, useRef, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useTranslation } from "react-i18next";
import { FolderInput } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { CacheMode, Speed } from "@/lib/types";
import { Toaster } from "@/components/ui/sonner";
import { StatsConsent } from "@/components/StatsConsent";
import { Welcome } from "@/features/welcome/Welcome";
import { DiskView } from "@/features/disk/DiskView";
import { AppsView } from "@/features/apps/AppsView";
import { DonateView } from "@/features/donate/DonateView";
import { DevView } from "@/features/dev/DevView";
import { PhotosView } from "@/features/photos/PhotosView";
import { setupTray } from "@/features/tray";

type Screen = { name: "welcome" } | { name: "disk"; root: string } | { name: "apps" } | { name: "dev" } | { name: "photos" } | { name: "donate" };

export default function App() {
  const [home, setHome] = useState("");
  const [screen, setScreen] = useState<Screen>({ name: "welcome" });
  const [speed, setSpeedState] = useState<Speed>(() => (localStorage.getItem("speed") as Speed) || "balanced");

  const [cacheMode, setCacheModeState] = useState<CacheMode>(() => (localStorage.getItem("cacheMode") as CacheMode) || "auto");
  // The backend starts in `auto`; tell it the saved choice.
  useEffect(() => {
    api.setCacheMode(cacheMode).catch(() => {});
  }, [cacheMode]);

  const { t, i18n } = useTranslation();
  const [dropping, setDropping] = useState(false);
  const openFolder = (root: string) => setScreen({ name: "disk", root });
  const openFolderRef = useRef(openFolder);
  openFolderRef.current = openFolder;

  useEffect(() => {
    homeDir().then(setHome);
  }, []);

  // Drop a folder anywhere on the window to scan it.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(async (e) => {
      if (e.payload.type === "enter" || e.payload.type === "over") setDropping(true);
      else setDropping(false);
      if (e.payload.type !== "drop") return;
      const path = e.payload.paths[0];
      if (!path) return;
      if (await api.isDir(path)) openFolderRef.current(path);
      else toast.error(t("app.dropFolderOnly"));
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [t]);

  // Menu bar / tray icon; rebuilt when the language changes so its labels follow.
  useEffect(() => {
    if (!home) return;
    let dispose: (() => void) | null = null;
    let cancelled = false;
    setupTray((path) => openFolderRef.current(path), home)
      .then((d) => (cancelled ? d() : (dispose = d)))
      .catch(() => {});
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [home, i18n.language]);

  const setSpeed = (s: Speed) => {
    setSpeedState(s);
    localStorage.setItem("speed", s);
  };
  const setCacheMode = (m: CacheMode) => {
    setCacheModeState(m);
    localStorage.setItem("cacheMode", m);
  };
  const goHome = () => setScreen({ name: "welcome" });

  return (
    <>
      {screen.name === "welcome" && (
        <Welcome
          home={home}
          speed={speed}
          onSpeed={setSpeed}
          cacheMode={cacheMode}
          onCacheMode={setCacheMode}
          onOpenFolder={openFolder}
          onOpenApps={() => setScreen({ name: "apps" })}
          onOpenDev={() => setScreen({ name: "dev" })}
          onOpenPhotos={() => setScreen({ name: "photos" })}
          onOpenDonate={() => setScreen({ name: "donate" })}
        />
      )}
      {screen.name === "disk" && (
        <DiskView key={screen.root} root={screen.root} home={home} speed={speed} onSpeed={setSpeed} onExit={goHome} />
      )}
      {screen.name === "apps" && <AppsView speed={speed} onBack={goHome} />}
      {screen.name === "dev" && <DevView home={home} speed={speed} onBack={goHome} />}
      {screen.name === "photos" && <PhotosView home={home} speed={speed} onBack={goHome} />}
      {screen.name === "donate" && <DonateView onBack={goHome} />}
      {dropping && (
        <div className="pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-lg font-medium">
            <FolderInput className="size-10 text-primary" />
            {t("app.dropToScan")}
          </div>
        </div>
      )}
      <StatsConsent />
      <Toaster position="bottom-right" />
    </>
  );
}
