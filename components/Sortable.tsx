"use client";

import { Children, isValidElement, useEffect, useMemo, useState, type DragEvent, type ReactElement, type ReactNode } from "react";

// A group of boxes the user can rearrange (the Metrics page's sections). Each child needs a stable `key`; in edit mode every
// box can be dragged onto another to swap places, or moved with its ◀ ▶ buttons (touch screens have no drag and drop).
// The order is remembered per section in this browser.

const STORE = "metrics.layout.v1";

function readAll(): Record<string, string[]> {
  try { return JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, string[]>; } catch { return {}; }
}
function writeSection(section: string, ids: string[] | null) {
  try {
    const all = readAll();
    if (ids) all[section] = ids; else delete all[section];
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch { /* storage unavailable: the order lasts until the page closes */ }
}

// Forgets every saved order (the Reset layout button); sections re-read it when `layoutVersion` changes.
export function resetMetricsLayout(): void {
  try { localStorage.removeItem(STORE); } catch { /* ignore */ }
}

export function Sortable({ section, editing, className, itemClassNames, layoutVersion = 0, children }: {
  section: string;
  editing: boolean;
  className?: string;                       // the container (grid, stack…)
  itemClassNames?: Record<string, string>;  // classes a box needs on its wrapper, by key (e.g. a column span)
  layoutVersion?: number;                   // bump to re-read the saved order after a reset
  children: ReactNode;
}) {
  const items = useMemo(
    () => Children.toArray(children).filter((c): c is ReactElement => isValidElement(c)).map(c => ({ id: String(c.key ?? ""), node: c })),
    [children],
  );
  const [order, setOrder] = useState<string[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  useEffect(() => { setOrder(readAll()[section] ?? []); }, [section, layoutVersion]);

  const sorted = useMemo(() => {
    const idx = (id: string) => { const i = order.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
    return items.map((it, n) => ({ it, n })).sort((a, b) => idx(a.it.id) - idx(b.it.id) || a.n - b.n).map(x => x.it);
  }, [items, order]);

  const move = (id: string, toIndex: number) => {
    const ids = sorted.map(s => s.id);
    const from = ids.indexOf(id);
    if (from < 0 || toIndex < 0 || toIndex >= ids.length || from === toIndex) return;
    ids.splice(toIndex, 0, ids.splice(from, 1)[0]);
    setOrder(ids);
    writeSection(section, ids);
  };

  const onDragOver = (e: DragEvent, overId: string) => {
    if (!dragId) return;
    e.preventDefault();
    if (overId !== dragId) move(dragId, sorted.findIndex(s => s.id === overId));
  };

  return (
    <div className={className}>
      {sorted.map((s, i) => (
        <div
          key={s.id}
          className={`min-w-0 ${itemClassNames?.[s.id] ?? ""} ${editing ? `relative rounded-xl outline-dashed outline-1 outline-sky-400/50 ${dragId === s.id ? "opacity-40" : "cursor-grab"}` : ""}`}
          draggable={editing}
          onDragStart={e => { if (!editing) return; setDragId(s.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", s.id); }}
          onDragEnd={() => setDragId(null)}
          onDragOver={e => onDragOver(e, s.id)}
          onDrop={e => { e.preventDefault(); setDragId(null); }}
        >
          {/* while rearranging, the box is a handle: its contents don't react to the pointer */}
          <div className={editing ? "pointer-events-none select-none" : ""}>{s.node}</div>
          {editing && (
            <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1 rounded-md bg-slate-950/90 border border-sky-400/40 px-1 py-0.5 text-[11px] text-sky-200 shadow">
              <span aria-hidden title="Drag to rearrange">⠿</span>
              <button type="button" onClick={() => move(s.id, i - 1)} disabled={i === 0} className="px-1 hover:text-white disabled:opacity-30" aria-label="Move earlier" title="Move earlier">◀</button>
              <button type="button" onClick={() => move(s.id, i + 1)} disabled={i === sorted.length - 1} className="px-1 hover:text-white disabled:opacity-30" aria-label="Move later" title="Move later">▶</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
