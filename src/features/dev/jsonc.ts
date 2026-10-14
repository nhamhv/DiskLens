// Tiny helpers for editing the user's rules file as text, so comments and layout survive.

/** Blanks comments and string contents (keeping the quotes and newlines), so offsets still match. */
export function mask(text: string): string {
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== "\n") {
        if (text[i] === "\\") out[i++] = " ";
        if (i < text.length) out[i++] = " ";
      }
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") out[i++] = " ";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== "\n") out[i] = " ";
    } else i++;
  }
  return out.join("");
}

/** Offset of the `"id": "<id>"` pair for this rule, outside comments; -1 if absent. */
export function findRule(text: string, id: string): number {
  const masked = mask(text);
  // Masking blanks string contents, so every key reads as `"  "`; check the real text.
  const re = /" *"\s*:\s*"/g;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const value = m.index + m[0].length;
    if (text.startsWith('"id"', m.index) && text.startsWith(id + '"', value)) return m.index;
  }
  return -1;
}

/** Inserts `snippet` as the first element of the top-level "rules" array. Null if there is none. */
export function insertRule(text: string, snippet: string): { text: string; at: number } | null {
  const masked = mask(text);
  const re = /" *"\s*:\s*\[/g;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    if (!text.startsWith('"rules"', m.index)) continue;
    const open = m.index + m[0].length;
    const empty = /^\s*\]/.test(masked.slice(open));
    const body = snippet
      .split("\n")
      .map((l) => "    " + l)
      .join("\n");
    const insert = "\n" + body + (empty ? "\n  " : ",");
    return { text: text.slice(0, open) + insert + text.slice(open), at: open + 1 };
  }
  return null;
}

export const lineOf = (text: string, offset: number) => text.slice(0, offset).split("\n").length;
