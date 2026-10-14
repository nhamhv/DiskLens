import { useTranslation } from "react-i18next";
import { ArrowLeft, Bug, Coffee, ExternalLink, Heart, Languages, Star, Wallet } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { DONATIONS, LINKS } from "./links";

const open = (url: string) => api.openPath(url);

export function DonateView({ onBack }: { onBack(): void }) {
  const { t } = useTranslation();
  const help = LINKS.repo
    ? [
        { icon: Star, label: t("donate.star"), url: LINKS.repo },
        { icon: Bug, label: t("donate.report"), url: `${LINKS.repo}/issues` },
        { icon: Languages, label: t("donate.translate"), url: `${LINKS.repo}/blob/main/CONTRIBUTING.md` },
      ]
    : [];

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Button size="sm" variant="outline" onClick={onBack}>
          <ArrowLeft /> {t("common.home")}
        </Button>
        <h1 className="font-medium">{t("donate.title")}</h1>
      </header>

      <div className="flex flex-1 flex-col items-center overflow-y-auto px-6 py-14">
        <div className="mb-5 grid size-20 place-items-center rounded-full bg-rose-500/15">
          <Heart className="size-10 fill-rose-400 text-rose-400" />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">{t("donate.heading")}</h2>
        <p className="mt-2 max-w-md text-center text-sm text-muted-foreground">{t("donate.pitch")}</p>

        <div className="mt-8 grid w-full max-w-md gap-3">
          {DONATIONS.map((d) => (
            <button
              key={d.id}
              onClick={() => open(d.url)}
              className="flex items-center gap-4 rounded-xl border bg-card/60 p-4 text-left transition-colors hover:bg-accent"
            >
              <span className="grid size-11 shrink-0 place-items-center rounded-lg" style={{ background: d.color, color: d.text }}>
                {d.id === "sponsors" ? (
                  <Heart className="size-5" />
                ) : d.id === "paypal" ? (
                  <Wallet className="size-5" />
                ) : (
                  <Coffee className="size-5" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{t(`donate.${d.id}`)}</span>
                <span className="block text-xs text-muted-foreground">{t(`donate.${d.id}Hint`)}</span>
              </span>
              <ExternalLink className="size-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>

        {help.length > 0 && (
          <div className="mt-10 w-full max-w-md">
            <div className="mb-2 text-xs text-muted-foreground">{t("donate.otherWays")}</div>
            <div className="flex flex-wrap gap-2">
              {help.map(({ icon: Icon, label, url }) => (
                <Button key={url} size="sm" variant="outline" onClick={() => open(url)}>
                  <Icon /> {label}
                </Button>
              ))}
            </div>
          </div>
        )}

        <p className="mt-10 text-xs text-muted-foreground">{t("donate.thanks")}</p>
      </div>
    </div>
  );
}
