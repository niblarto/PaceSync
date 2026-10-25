"use client";

import { useMemo, useState } from "react";
import { currentArtistSegment, formatArtistName, splitArtistList } from "@/lib/artist-list";

// Text field for one or more comma-separated artist names (Song Crawler);
// "a name in quotes, keeps its commas".
// Each name gets its own autofill: the suggestions follow whatever is typed
// after the last comma, and picking one fills in just that name and adds
// ", " ready for the next. (A native <datalist> can't do this - it matches
// the whole field.)
const MAX_SUGGESTIONS = 8;

export function ArtistListInput({ value, onChange, options, disabled, onEnter, placeholder, className }: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  disabled?: boolean;
  onEnter?: () => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const { before: prefix, segment } = currentArtistSegment(value); // prefix = everything before the name being typed

  const suggestions = useMemo(() => {
    const q = segment.toLowerCase();
    if (!q) return [];
    const already = new Set(splitArtistList(prefix).map(x => x.toLowerCase()));
    const starts: string[] = [];
    const contains: string[] = [];
    for (const o of options) {
      const l = o.toLowerCase();
      if (already.has(l) || l === q) continue;
      if (l.startsWith(q)) starts.push(o);
      else if (l.includes(q)) contains.push(o);
      if (starts.length >= MAX_SUGGESTIONS) break;
    }
    return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
  }, [options, segment, prefix]);

  const show = open && suggestions.length > 0;

  const pick = (name: string) => {
    onChange(`${prefix}${formatArtistName(name)}, `);
    setActive(-1);
    setOpen(true);
  };

  return (
    <div className="relative">
      <input
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        className={className}
        onChange={e => { onChange(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={e => {
          if (show && e.key === "ArrowDown") { e.preventDefault(); setActive(a => (a + 1) % suggestions.length); }
          else if (show && e.key === "ArrowUp") { e.preventDefault(); setActive(a => (a <= 0 ? suggestions.length - 1 : a - 1)); }
          else if (show && e.key === "Tab" && !e.shiftKey) { e.preventDefault(); pick(suggestions[active >= 0 ? active : 0]); }
          else if (show && e.key === "Enter" && active >= 0) { e.preventDefault(); pick(suggestions[active]); }
          else if (e.key === "Escape") { setOpen(false); setActive(-1); }
          else if (e.key === "Enter") onEnter?.();
        }}
      />
      {show && (
        <ul className="absolute z-30 left-0 right-0 top-full mt-1 max-h-56 overflow-y-auto rounded-lg border border-white/10 bg-slate-900 shadow-xl py-1">
          {suggestions.map((s, i) => (
            <li
              key={s}
              // mousedown (not click) so the input keeps focus and doesn't blur first
              onMouseDown={e => { e.preventDefault(); pick(s); }}
              onMouseEnter={() => setActive(i)}
              className={`px-2.5 py-1 text-sm cursor-pointer truncate ${i === active ? "bg-teal-500/20 text-teal-200" : "text-slate-200 hover:bg-white/5"}`}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
