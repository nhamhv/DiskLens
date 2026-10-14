import i18n from "@/i18n";
import { baseName } from "@/lib/format";

/** "Home" / "Whole Disk" for the well-known roots, otherwise the folder name. */
export const rootLabel = (root: string, home: string) =>
  root === "/" ? i18n.t("common.wholeDisk") : root === home ? i18n.t("common.home") : baseName(root);
