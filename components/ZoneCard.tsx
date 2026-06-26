import type { RunningZone } from "@/types";

interface Props {
  zone: RunningZone;
  selected: boolean;
  onClick: () => void;
}

export function ZoneCard({ zone, selected, onClick }: Props) {
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-lg border p-4 text-left transition-all ${
        selected
          ? "border-green-500 bg-green-500/10 ring-1 ring-green-500"
          : "border-white/10 bg-slate-900/85 backdrop-blur-sm hover:border-white/20"
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Zone {zone.number}
        </span>
        <span className="text-xs text-slate-400">
          {zone.hrMin === 0
            ? `< ${zone.hrMax}`
            : `${zone.hrMin}–${zone.hrMax === -1 ? "max" : zone.hrMax}`}{" "}
          <span className="text-slate-600">bpm HR</span>
        </span>
      </div>
      <p className="font-semibold text-sm">{zone.name}</p>
      <p className="text-xs text-slate-500 mt-0.5">{zone.description}</p>
      <p className="text-xs text-slate-600 mt-1">{zone.pace}</p>
      <div className="mt-2 flex items-center gap-1.5">
        <span className={`text-xs font-bold rounded-full px-2 py-0.5 ${zone.color} text-black`}>
          ♪ {zone.bpmMin}–{zone.bpmMax} BPM
        </span>
        <span className="text-xs text-slate-600">music tempo</span>
      </div>
    </button>
  );
}
