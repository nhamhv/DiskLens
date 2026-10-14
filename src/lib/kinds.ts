import { ApplicationsIcon } from "@/components/icons";
import {
  BrainCircuit,
  Cloud,
  Code,
  Container,
  Database,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  Film,
  Folder,
  FolderGit2,
  Hammer,
  HardDrive,
  Image,
  Layers,
  Library,
  Mail,
  Monitor,
  Music,
  Settings,
  Smartphone,
  Trash2,
  Users,
  type LucideIcon,
} from "lucide-react";
import i18n from "@/i18n";
import type { Entry } from "@/lib/types";

export interface Kind {
  /** Also the translation key under `kinds.*`. */
  id: string;
  icon: LucideIcon;
  /** Tile background; muted enough for white text. */
  color: string;
}

const k = (id: string, icon: LucideIcon, color: string): Kind => ({ id, icon, color });

export const KINDS = {
  trash: k("trash", Trash2, "#5f5853"),
  cache: k("cache", Database, "#5d7a55"),
  build: k("build", Hammer, "#6f7a45"),
  repo: k("repo", FolderGit2, "#a5603e"),
  dev: k("dev", Code, "#4f6a8a"),
  container: k("container", Container, "#3f7a80"),
  ai: k("ai", BrainCircuit, "#6c5a92"),
  apps: k("apps", ApplicationsIcon, "#3d6f9a"),
  library: k("library", Library, "#86644f"),
  system: k("system", Settings, "#5a5f68"),
  users: k("users", Users, "#7a6a55"),
  docs: k("docs", FileText, "#9a7443"),
  downloads: k("downloads", Download, "#8d6a3c"),
  desktop: k("desktop", Monitor, "#87704a"),
  images: k("images", Image, "#8a5478"),
  video: k("video", Film, "#7b4f86"),
  music: k("music", Music, "#a04f62"),
  mail: k("mail", Mail, "#4f7396"),
  cloud: k("cloud", Cloud, "#4a7fa0"),
  mobile: k("mobile", Smartphone, "#5b6a9a"),
  archive: k("archive", FileArchive, "#9b4f3f"),
  disk: k("disk", HardDrive, "#6a4f45"),
  code: k("code", FileCode, "#4f6a8a"),
  imageFile: k("imageFile", FileImage, "#8a5478"),
  videoFile: k("videoFile", FileVideo, "#7b4f86"),
  audioFile: k("audioFile", FileAudio, "#a04f62"),
  docFile: k("docFile", FileText, "#9a7443"),
  file: k("file", File, "#55606a"),
  group: k("group", Layers, "#5e5650"),
} satisfies Record<string, Kind>;

const FOLDERS: Record<string, Kind> = {
  ".Trash": KINDS.trash,
  // Caches — regenerated on demand
  Caches: KINDS.cache, ".cache": KINDS.cache, CachedData: KINDS.cache, Cache: KINDS.cache,
  node_modules: KINDS.cache, ".npm": KINDS.cache, ".pnpm-store": KINDS.cache, ".yarn": KINDS.cache,
  ".gradle": KINDS.cache, DerivedData: KINDS.cache, __pycache__: KINDS.cache, ".pytest_cache": KINDS.cache,
  ".next": KINDS.cache, ".turbo": KINDS.cache, ".parcel-cache": KINDS.cache, ".m2": KINDS.cache,
  Logs: KINDS.cache, logs: KINDS.cache,
  // Build output
  target: KINDS.build, build: KINDS.build, dist: KINDS.build, out: KINDS.build, ".build": KINDS.build,
  // Source trees
  ".git": KINDS.repo, "gitlab.com": KINDS.repo, "github.com": KINDS.repo, "bitbucket.org": KINDS.repo,
  src: KINDS.repo, Projects: KINDS.repo, projects: KINDS.repo, code: KINDS.repo, workspace: KINDS.repo,
  // Toolchains
  ".cargo": KINDS.dev, ".rustup": KINDS.dev, ".nvm": KINDS.dev, ".bun": KINDS.dev, ".deno": KINDS.dev,
  ".android": KINDS.dev, Android: KINDS.dev, ".vscode": KINDS.dev, ".vscode-server": KINDS.dev,
  ".cursor": KINDS.dev, Developer: KINDS.dev, homebrew: KINDS.dev, Homebrew: KINDS.dev, go: KINDS.dev,
  ".pyenv": KINDS.dev, ".conda": KINDS.dev, miniconda3: KINDS.dev, anaconda3: KINDS.dev, ".local": KINDS.dev,
  ".config": KINDS.dev, ".solana": KINDS.dev, ".foundry": KINDS.dev, ".claude": KINDS.dev, opt: KINDS.dev,
  // Containers & VMs
  ".docker": KINDS.container, Docker: KINDS.container, "com.docker.docker": KINDS.container,
  ".colima": KINDS.container, ".orbstack": KINDS.container, OrbStack: KINDS.container,
  "Parallels": KINDS.container, ".lima": KINDS.container, UTM: KINDS.container,
  // AI models
  ".ollama": KINDS.ai, ".lmstudio": KINDS.ai, huggingface: KINDS.ai, ".huggingface": KINDS.ai,
  // macOS layout
  Applications: KINDS.apps, Library: KINDS.library, "Application Support": KINDS.library,
  "Group Containers": KINDS.library, Containers: KINDS.library,
  System: KINDS.system, usr: KINDS.system, bin: KINDS.system, sbin: KINDS.system, private: KINDS.system,
  var: KINDS.system, cores: KINDS.system, etc: KINDS.system, Volumes: KINDS.system,
  Users: KINDS.users,
  Documents: KINDS.docs, Downloads: KINDS.downloads, Desktop: KINDS.desktop,
  Pictures: KINDS.images, Movies: KINDS.video, Music: KINDS.music,
  Mail: KINDS.mail,
  "Mobile Documents": KINDS.cloud, CloudStorage: KINDS.cloud, "iCloud Drive": KINDS.cloud,
  Dropbox: KINDS.cloud, "Google Drive": KINDS.cloud, OneDrive: KINDS.cloud,
  MobileSync: KINDS.mobile, CoreSimulator: KINDS.mobile,
};

const EXTENSIONS: [Kind, string[]][] = [
  [KINDS.archive, ["zip", "dmg", "pkg", "xip", "iso", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst"]],
  [KINDS.disk, ["raw", "img", "vmdk", "qcow2", "vdi", "sparseimage", "sparsebundle", "vhdx", "hdd"]],
  [KINDS.videoFile, ["mp4", "mov", "mkv", "avi", "webm", "m4v", "flv"]],
  [KINDS.audioFile, ["mp3", "wav", "flac", "aac", "m4a", "ogg", "aiff"]],
  [KINDS.imageFile, ["png", "jpg", "jpeg", "gif", "heic", "webp", "psd", "tiff", "raw", "svg", "cr2", "nef"]],
  [KINDS.docFile, ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "key", "pages", "numbers", "txt", "md"]],
  [KINDS.ai, ["gguf", "safetensors", "ckpt", "onnx", "pt", "bin"]],
  [KINDS.code, ["js", "ts", "tsx", "rs", "go", "py", "java", "kt", "swift", "c", "cpp", "h", "json", "sql", "log"]],
];

const BY_EXT = new Map<string, Kind>(EXTENSIONS.flatMap(([kind, exts]) => exts.map((e) => [e, kind] as const)));

const ext = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

/** Neutral folders get a stable warm shade so neighbouring tiles stay distinguishable. */
const FOLDER_SHADES = ["#8b6b5a", "#946f4b", "#7d5f49", "#86663f", "#80614f", "#6e5a4d", "#9b5a3f", "#6a5040"];

export function kindOf(entry: Entry | null): Kind {
  if (!entry) return KINDS.group;
  if (entry.isDir) {
    const known = FOLDERS[entry.name];
    if (known) return known;
    const e = ext(entry.name);
    if (e === "app") return KINDS.apps;
    if (e === "photoslibrary") return KINDS.images;
    if (e === "sparsebundle" || e === "pvm" || e === "utm") return KINDS.disk;
    let h = 0;
    for (const c of entry.name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return { id: "folder", icon: Folder, color: FOLDER_SHADES[h % FOLDER_SHADES.length] };
  }
  return BY_EXT.get(ext(entry.name)) ?? KINDS.file;
}

export const kindLabel = (kind: Kind) => i18n.t(`kinds.${kind.id}`);
