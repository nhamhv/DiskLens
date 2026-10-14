import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, CircleCheck, Loader2, RotateCcw, Save, Search, TriangleAlert } from "lucide-react";
import { api } from "@/lib/api";
import type { RuleSummary, RuleWarning, RulesCheck, RulesFile, Safety } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EcoDot, SafetyIcon } from "./ItemRow";
import { findRule, insertRule, lineOf } from "./jsonc";
import { eco, tildify } from "./model";
import { shortcut } from "@/lib/platform";

const LINE = 20; // px; the gutter and the textarea share it
const POLL_MS = 1500;

// The draft survives leaving this screen; only Revert or a reload drops it.
const memo = { base: null as RulesFile | null, draft: null as string | null };

/** Unsaved edits in the rules editor, for the dot on the Rules button. */
export const hasRulesDraft = () => memo.base !== null && memo.draft !== null && memo.draft !== memo.base.text;

interface Props {
  home: string;
  onBack(): void;
  /** After a save, so the results can be rescanned with the new rules. */
  onSaved(): void;
}

export function RulesView({ home, onBack, onSaved }: Props) {
  const { t } = useTranslation();
  const [base, setBase] = useState<RulesFile | null>(memo.base);
  const [text, setText] = useState(memo.draft ?? memo.base?.text ?? "");
  const [check, setCheck] = useState<RulesCheck | null>(null);
  const [checking, setChecking] = useState(false);
  /** The file on disk differs from `base` and the editor has unsaved edits. */
  const [outside, setOutside] = useState<RulesFile | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);

  const dirty = base !== null && text !== base.text;
  // Refs for the poller, which outlives renders.
  const live = useRef({ base, dirty, saving });
  live.current = { base, dirty, saving };

  useEffect(() => {
    memo.base = base;
    memo.draft = text;
  }, [base, text]);

  const load = useCallback((file: RulesFile) => {
    setBase(file);
    setText(file.text);
    setOutside(null);
  }, []);

  useEffect(() => {
    if (!memo.base) api.devRulesRead().then(load, (e) => toast.error(String(e)));
  }, [load]);

  // Notice edits made by another editor: reload if nothing here is unsaved, else ask.
  useEffect(() => {
    const poll = async () => {
      const { base, dirty, saving } = live.current;
      if (!base || saving) return;
      const mtime = await api.devRulesStat().catch(() => base.mtime);
      if (mtime === base.mtime) return;
      const file = await api.devRulesRead().catch(() => null);
      if (!file || live.current.saving || file.mtime === live.current.base?.mtime) return;
      if (dirty) setOutside(file);
      else {
        load(file);
        toast(t("dev.reloadedOutside"));
      }
    };
    const id = setInterval(poll, POLL_MS);
    window.addEventListener("focus", poll);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", poll);
    };
  }, [load, t]);

  // Validate as the user types, with the same loader a scan uses.
  useEffect(() => {
    let alive = true;
    setChecking(true);
    const id = setTimeout(() => {
      api
        .devRulesCheck(text)
        .then((c) => alive && setCheck(c))
        .catch((e) => alive && toast.error(String(e)))
        .finally(() => alive && setChecking(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [text]);

  const problems = check?.warnings ?? [];
  const valid = !checking && check !== null && problems.length === 0;
  const badLines = useMemo(() => new Set(problems.map((w) => w.line)), [problems]);
  const lines = useMemo(() => text.split("\n").length, [text]);

  const save = async (force = false) => {
    if (!base || saving) return;
    setSaving(true);
    try {
      const res = await api.devRulesSave(text, base.mtime, force);
      if (res.status === "saved") {
        load(res.file);
        toast.success(t("dev.rulesSaved"));
        onSaved();
      } else if (res.status === "conflict") setOutside(res.file);
      else {
        setCheck((c) => (c ? { ...c, warnings: res.warnings } : c));
        toast.error(t("dev.cantSave"));
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  /** Puts the caret at `offset` and scrolls it into view. */
  const goTo = (offset: number) => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(offset, offset);
    el.scrollTop = Math.max(0, (lineOf(el.value, offset) - 4) * LINE);
  };

  const goToLine = (w: RuleWarning) => {
    if (w.line < 1) return;
    const before = text.split("\n").slice(0, w.line - 1).join("\n").length;
    goTo(Math.min(text.length, before + (w.line > 1 ? 1 : 0) + Math.max(0, w.col - 1)));
  };

  const insert = (snippet: string) => {
    const res = insertRule(text, snippet);
    if (!res) return toast.error(t("dev.noRulesArray"));
    setText(res.text);
    requestAnimationFrame(() => goTo(res.at));
  };

  // Rules in the user's file first, then one group per ecosystem; A→Z by label inside each.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (check?.rules ?? []).filter((r) => !q || r.id.toLowerCase().includes(q) || r.label?.toLowerCase().includes(q));
    const name = (r: RuleSummary) => r.label ?? r.id;
    const byName = (a: RuleSummary, b: RuleSummary) => name(a).localeCompare(name(b)) || a.id.localeCompare(b.id);
    const mine = list.filter((r) => r.custom || r.overridden || r.disabled || r.broken).sort(byName);
    const byEco = new Map<string, RuleSummary[]>();
    for (const r of list) if (!mine.includes(r)) byEco.set(r.eco ?? "other", [...(byEco.get(r.eco ?? "other") ?? []), r]);
    const ecoGroups = [...byEco]
      .sort(([a], [b]) => eco(a).label.localeCompare(eco(b).label))
      .map(([id, rules]) => ({ key: id, title: eco(id).label, rules: rules.sort(byName) }));
    return [...(mine.length ? [{ key: "mine", title: t("dev.inYourFile"), rules: mine }] : []), ...ecoGroups];
  }, [check, query, t]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      if (dirty && valid) save();
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const el = e.currentTarget;
      el.setRangeText("  ", el.selectionStart, el.selectionEnd, "end");
      setText(el.value);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Button size="sm" variant="outline" onClick={onBack}>
          <ArrowLeft /> {t("dev.backToResults")}
        </Button>
        <h1 className="shrink-0 font-medium">{t("dev.rulesTitle")}</h1>
        {base && <span className="truncate font-mono text-xs text-muted-foreground">{tildify(base.path, home)}</span>}
        <span className="flex-1" />
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {checking ? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> {t("dev.validating")}
            </>
          ) : problems.length > 0 ? (
            <span className="flex items-center gap-1 text-amber-400">
              <TriangleAlert className="size-3.5" /> {t("dev.rulesWarnings", { count: problems.length })}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-emerald-400">
              <CircleCheck className="size-3.5" /> {t("dev.noProblems")}
            </span>
          )}
          {check && ` · ${t("dev.rulesStatus", { builtin: check.builtin, custom: check.custom, disabled: check.disabled })}`}
          {" · "}
          {dirty ? t("dev.unsaved") : t("dev.saved")}
        </span>
        <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => base && setText(base.text)}>
          <RotateCcw /> {t("dev.revert")}
        </Button>
        <Button size="sm" disabled={!dirty || !valid || saving} onClick={() => save()} title={valid ? shortcut("S") : t("dev.cantSave")}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />} {t("dev.save")}
        </Button>
      </header>

      {outside && (
        <div className="flex shrink-0 items-center gap-3 border-b bg-amber-500/10 px-3 py-2 text-xs">
          <TriangleAlert className="size-3.5 shrink-0 text-amber-400" />
          <span className="flex-1">{outside.mtime === null ? t("dev.deletedOutside") : t("dev.changedOutside")}</span>
          <Button size="xs" variant="outline" onClick={() => load(outside)}>
            {t("dev.loadDisk")}
          </Button>
          <Button
            size="xs"
            variant="secondary"
            title={t("dev.keepMineHint")}
            onClick={() => {
              // Adopt the disk version as the base, so the next save overwrites it on purpose.
              setBase(outside);
              setOutside(null);
            }}
          >
            {t("dev.keepMine")}
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex w-80 shrink-0 flex-col border-r">
          <div className="relative p-2">
            <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("dev.searchRules")} className="h-8 pl-7" />
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-2 pb-2">
              {groups.map((g) => (
                <section key={g.key}>
                  <h3 className="sticky top-0 z-10 flex items-center gap-1.5 bg-background/95 px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase backdrop-blur">
                    {g.key !== "mine" && <EcoDot id={g.key} />}
                    {g.title}
                    <span className="font-normal tabular-nums">{g.rules.length}</span>
                  </h3>
                  {g.rules.map((r) => (
                    <RuleRow key={r.id} rule={r} text={text} onGoTo={goTo} onInsert={insert} />
                  ))}
                </section>
              ))}
            </div>
          </ScrollArea>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 font-mono text-xs">
            <div
              ref={gutter}
              aria-hidden
              className="w-12 shrink-0 overflow-hidden border-r bg-muted/30 py-2 pr-2 text-right text-muted-foreground select-none"
            >
              {Array.from({ length: lines }, (_, i) => (
                <div key={i} style={{ height: LINE, lineHeight: `${LINE}px` }} className={cn(badLines.has(i + 1) && "font-bold text-amber-400")}>
                  {i + 1}
                </div>
              ))}
            </div>
            <textarea
              ref={area}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              onScroll={(e) => gutter.current && (gutter.current.scrollTop = e.currentTarget.scrollTop)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              wrap="off"
              disabled={!base}
              style={{ lineHeight: `${LINE}px` }}
              className="min-w-0 flex-1 resize-none bg-transparent px-3 py-2 outline-none"
            />
          </div>
          <div className="max-h-40 shrink-0 overflow-y-auto border-t px-3 py-2 text-xs">
            {problems.length === 0 ? (
              <span className="text-muted-foreground">{t("dev.editorHint")}</span>
            ) : (
              problems.map((w, i) => (
                <button
                  key={i}
                  className="flex w-full gap-2 rounded px-1 py-0.5 text-left hover:bg-accent"
                  onClick={() => goToLine(w)}
                >
                  <TriangleAlert className="mt-0.5 size-3 shrink-0 text-amber-400" />
                  {w.line > 0 && <span className="shrink-0 font-mono text-muted-foreground">{w.line}:{w.col}</span>}
                  <span>{w.message}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RuleRow({
  rule: r,
  text,
  onGoTo,
  onInsert,
}: {
  rule: RuleSummary;
  text: string;
  onGoTo(offset: number): void;
  onInsert(snippet: string): void;
}) {
  const { t } = useTranslation();
  const at = findRule(text, r.id);
  return (
    <div
      className={cn("group rounded-md px-2 py-1.5 text-xs hover:bg-accent", at >= 0 && "cursor-pointer")}
      title={at >= 0 ? t("dev.jumpHint") : undefined}
      onClick={() => at >= 0 && onGoTo(at)}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {r.safety && ["safe", "rebuild", "caution"].includes(r.safety) && <SafetyIcon safety={r.safety as Safety} />}
        <span className={cn("truncate text-sm", r.disabled && "text-muted-foreground line-through")}>{r.label ?? r.id}</span>
        <span className="flex-1" />
        {r.broken && <Badge variant="destructive">{t("dev.ruleError")}</Badge>}
        {r.disabled && <Badge variant="secondary">{t("dev.ruleOff")}</Badge>}
        {r.custom && <Badge variant="outline">{t("dev.custom")}</Badge>}
        {r.overridden && <Badge variant="outline">{t("dev.ruleChanged")}</Badge>}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={[r.id, r.type].filter(Boolean).join(" · ")}>
          {r.id}
        </span>
        <span className="flex-1" />
        {r.builtin && at < 0 && (
          <span className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100">
            <Button
              size="xs"
              variant="ghost"
              title={t("dev.turnOffHint")}
              onClick={(e) => {
                e.stopPropagation();
                onInsert(`{ "id": ${JSON.stringify(r.id)}, "disabled": true }`);
              }}
            >
              {t("dev.turnOff")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              title={t("dev.customizeHint")}
              onClick={(e) => {
                e.stopPropagation();
                onInsert(r.builtin!);
              }}
            >
              {t("dev.customize")}
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
