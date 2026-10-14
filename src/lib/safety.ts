import {
  AppWindow,
  Code,
  Container,
  Database,
  Download,
  FileText,
  Folder,
  Image,
  Mail,
  ScrollText,
  Settings,
  Trash2,
  Puzzle,
  type LucideIcon,
} from "lucide-react";
import i18n from "@/i18n";
import type { CategoryId, Entry, SafetyLevel } from "@/lib/types";

/** Legend order. */
export const SAFETY_LEVELS: SafetyLevel[] = ["safe", "review", "risky", "unknown"];

/** Tile colours for the "colour by safety" mode; muted enough for white text. */
export const SAFETY_COLORS: Record<SafetyLevel, string> = {
  safe: "#3f8f63",
  review: "#a7802f",
  risky: "#a8463d",
  unknown: "#5b6169",
};

export const safetyOf = (entry: Entry | null): SafetyLevel => entry?.safety ?? "unknown";
export const safetyLabel = (level: SafetyLevel) => i18n.t(`safety.${level}`);

export const CATEGORIES: Record<CategoryId, { icon: LucideIcon; color: string }> = {
  system: { icon: Settings, color: "#c2554b" },
  applications: { icon: AppWindow, color: "#4f8fc0" },
  developer: { icon: Code, color: "#8b6fd0" },
  caches: { icon: Database, color: "#4fae7d" },
  logs: { icon: ScrollText, color: "#6fae4f" },
  trash: { icon: Trash2, color: "#8a8079" },
  appData: { icon: Puzzle, color: "#c26a8f" },
  containers: { icon: Container, color: "#7c6fc0" },
  mail: { icon: Mail, color: "#4f7fc0" },
  media: { icon: Image, color: "#d07a4f" },
  documents: { icon: FileText, color: "#c9a24a" },
  downloads: { icon: Download, color: "#4fa8b0" },
  other: { icon: Folder, color: "#7d838b" },
};

export const categoryLabel = (id: CategoryId) => i18n.t(`category.${id}`);
