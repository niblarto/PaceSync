"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";

// Floats content just below an anchor element via a body portal, so it can
// extend past scroll containers and card boundaries without being clipped.
export function FloatingCard({ anchor, children }: { anchor: HTMLElement | null; children: React.ReactNode }) {
  const [style, setStyle] = useState<React.CSSProperties | null>(null);

  useEffect(() => {
    if (!anchor) { setStyle(null); return; }
    const update = () => {
      const r = anchor.getBoundingClientRect();
      const vh = window.innerHeight;
      // Keep at least ~380px of card visible even when the row is near the bottom
      const top = Math.min(r.bottom + 6, Math.max(72, vh - 400));
      setStyle({
        position: "fixed",
        top,
        left: r.left,
        width: r.width,
        zIndex: 40,
        maxHeight: vh - top - 12,
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchor]);

  if (!style) return null;
  return createPortal(
    <div style={style} className="rounded-xl shadow-2xl shadow-black/70 ring-1 ring-white/20 overflow-y-auto no-scrollbar">
      {children}
    </div>,
    document.body,
  );
}
