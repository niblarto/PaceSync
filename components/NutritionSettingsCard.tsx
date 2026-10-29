"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { kgToStLb, LB_PER_KG, stLbToKg, type WeightUnit } from "@/lib/weight-format";

interface NutritionConfig {
  targetWeightKg: number | null;
  goalDate: string | null;
  goalDateAuto?: boolean;
  goalFromLoseIt?: boolean;
  dailyCalorieLimit: number | null;
  weightUnit: WeightUnit;
  trendDays: number;
  kcalPerKg: number;
  currentKg?: number | null;
  today?: string;
  maxLossLbPerWeek?: number;
}

const INPUT = "w-full rounded-lg bg-slate-800 border border-slate-700 text-sm px-3 py-2 text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500";

// Form fields are kept as strings so half-typed values don't get mangled.
interface Form {
  unit: WeightUnit;
  st: string;
  lb: string;
  single: string; // kg or lb, depending on unit
  goalDate: string;
  goalAuto: boolean;
  fromLi: boolean; // target weight and goal date come from Lose It!
  limit: string;
  trendDays: string;
  kcalPerKg: string;
}

function toForm(c: NutritionConfig): Form {
  const kg = c.targetWeightKg;
  const stlb = kg != null ? kgToStLb(kg) : null;
  return {
    unit: c.weightUnit,
    st: stlb ? String(stlb.st) : "",
    lb: stlb ? String(stlb.lb) : "",
    single: kg == null ? "" : c.weightUnit === "lb" ? (kg * LB_PER_KG).toFixed(1) : kg.toFixed(1),
    goalDate: c.goalDate ?? "",
    goalAuto: c.goalDateAuto !== false,
    fromLi: c.goalFromLoseIt !== false,
    limit: c.dailyCalorieLimit != null ? String(c.dailyCalorieLimit) : "",
    trendDays: String(c.trendDays),
    kcalPerKg: String(c.kcalPerKg),
  };
}

function targetKg(f: Form): number | null {
  if (f.unit === "st") {
    if (f.st.trim() === "" && f.lb.trim() === "") return null;
    const st = Number(f.st || 0), lb = Number(f.lb || 0);
    return Number.isFinite(st) && Number.isFinite(lb) ? stLbToKg(st, lb) : null;
  }
  if (f.single.trim() === "") return null;
  const v = Number(f.single);
  if (!Number.isFinite(v)) return null;
  return f.unit === "lb" ? v / LB_PER_KG : v;
}

// Settings → Nutrition: targets used by the /nutrition page.
// Earliest goal date reachable losing at most maxLb a week.
function earliestDate(currentKg: number, targetKg: number, today: string, maxLb: number): string {
  const d = new Date(`${today}T12:00:00`);
  if (currentKg > targetKg) d.setDate(d.getDate() + Math.ceil((currentKg - targetKg) / (maxLb / LB_PER_KG / 7)));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const prettyDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function NutritionSettingsCard() {
  const [form, setForm] = useState<Form | null>(null);
  const [limits, setLimits] = useState<{ currentKg: number | null; today: string; maxLb: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings/nutrition").then(r => r.json()).then(d => {
      if (d.error) return;
      setForm(toForm(d));
      setLimits({ currentKg: d.currentKg ?? null, today: d.today, maxLb: d.maxLossLbPerWeek ?? 2 });
    }).catch(() => {});
  }, []);

  function set<K extends keyof Form>(k: K, v: Form[K]) {
    setForm(f => (f ? { ...f, [k]: v } : f));
    setStatus(null);
  }

  // Switching unit converts the typed target rather than reinterpreting it.
  function changeUnit(unit: WeightUnit) {
    if (!form) return;
    const kg = targetKg(form);
    const next = toForm({
      targetWeightKg: kg, weightUnit: unit, goalDate: form.goalDate || null, goalDateAuto: form.goalAuto, goalFromLoseIt: form.fromLi,
      dailyCalorieLimit: form.limit ? Number(form.limit) : null,
      trendDays: Number(form.trendDays) || 28, kcalPerKg: Number(form.kcalPerKg) || 7700,
    });
    setForm({ ...next, limit: form.limit, trendDays: form.trendDays, kcalPerKg: form.kcalPerKg });
  }

  // The goal set in Lose It!: shown for reference, with a button to adopt its goal weight.
  const [li, setLi] = useState<{ goalKg: number; currentKg: number; date: string; plan: number | null; startKg: number | null; startDate: string | null } | null>(null);
  useEffect(() => {
    fetch("/api/loseit/goals").then(r => r.json()).then(d => {
      if (d.error || !d.goals) return;
      const g = d.goals;
      setLi({
        goalKg: g.goalWeightLb / LB_PER_KG, currentKg: g.currentWeightLb / LB_PER_KG, date: g.goalDate, plan: g.planLbPerWeek,
        startKg: g.startWeightLb != null ? g.startWeightLb / LB_PER_KG : null, startDate: g.startDate,
      });
    }).catch(() => {});
  }, []);
  const showWeight = (kg: number) => {
    if (!form) return "";
    if (form.unit === "kg") return `${kg.toFixed(1)} kg`;
    if (form.unit === "lb") return `${(kg * LB_PER_KG).toFixed(1)} lb`;
    const s = kgToStLb(kg);
    return `${s.st}st ${s.lb} lb`;
  };
  // With "use Lose It!'s goal" on, the target fields show Lose It!'s goal weight.
  const formLoaded = !!form;
  useEffect(() => {
    if (!li) return;
    setForm(f => {
      if (!f || !f.fromLi) return f;
      const next = toForm({
        targetWeightKg: li.goalKg, weightUnit: f.unit, goalDate: li.date, goalDateAuto: f.goalAuto, goalFromLoseIt: true,
        dailyCalorieLimit: f.limit ? Number(f.limit) : null, trendDays: Number(f.trendDays) || 28, kcalPerKg: Number(f.kcalPerKg) || 7700,
      });
      return { ...next, limit: f.limit, trendDays: f.trendDays, kcalPerKg: f.kcalPerKg };
    });
  }, [li, formLoaded]);

  const target = form ? targetKg(form) : null;
  const earliest = limits?.currentKg != null && target != null && limits.today
    ? earliestDate(limits.currentKg, target, limits.today, limits.maxLb) : null;
  const tooSoon = !!(form && !form.fromLi && !form.goalAuto && form.goalDate && earliest && form.goalDate < earliest);

  async function save() {
    if (!form || tooSoon) return;
    setSaving(true);
    setStatus(null);
    try {
      const body = {
        targetWeightKg: targetKg(form),
        goalDate: form.goalAuto ? (earliest ?? form.goalDate) || null : form.goalDate || null,
        goalDateAuto: form.goalAuto,
        goalFromLoseIt: form.fromLi,
        dailyCalorieLimit: form.limit ? Number(form.limit) : null,
        weightUnit: form.unit,
        trendDays: Number(form.trendDays),
        kcalPerKg: Number(form.kcalPerKg),
      };
      const res = await fetch("/api/settings/nutrition", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `Save failed (${res.status})`);
      setForm(toForm(d));
      setStatus("Saved.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl bg-slate-900/85 backdrop-blur-sm border border-white/10 p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-base">🥗 Nutrition goals</h2>
        <Link href="/nutrition" className="text-xs text-emerald-300 hover:text-emerald-200">Open Nutrition →</Link>
      </div>
      <p className="text-xs text-slate-500">
        Food comes from your Lose It! diary (read by the PaceSync server). Calories burnt and
        weigh-ins come from Garmin.
      </p>
      {!form ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-slate-400">Weight units</label>
            <div className="flex gap-1.5">
              {([["st", "Stones & lb"], ["lb", "Pounds"], ["kg", "Kilograms"]] as const).map(([u, label]) => (
                <button
                  key={u}
                  onClick={() => changeUnit(u)}
                  className={`flex-1 rounded-lg border text-xs font-medium px-3 py-2 transition-colors ${
                    form.unit === u
                      ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
                      : "bg-slate-800/60 border-white/10 text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {li && (
            <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2.5 text-xs space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-green-300">Set in Lose It!</span>
                <label className="flex items-center gap-2 text-slate-300">
                  <input type="checkbox" checked={form.fromLi} onChange={e => set("fromLi", e.target.checked)} />
                  Use Lose It!&apos;s goal weight and date
                </label>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5 text-slate-300">
                <div><span className="text-slate-500">Goal weight</span> {showWeight(li.goalKg)}</div>
                <div><span className="text-slate-500">Goal date</span> {prettyDate(li.date)}{li.plan ? ` (${li.plan} lb a week)` : ""}</div>
                <div><span className="text-slate-500">Current weight</span> {showWeight(li.currentKg)}</div>
                {li.startKg != null && <div><span className="text-slate-500">Started</span> {showWeight(li.startKg)}{li.startDate ? ` on ${prettyDate(li.startDate)}` : ""}</div>}
              </div>
              {!form.fromLi && target != null && Math.abs(target - li.goalKg) > 0.2 && (
                <p className="text-[11px] text-amber-300">Your target here ({showWeight(target)}) differs from Lose It!&apos;s goal weight.</p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs text-slate-400">Target weight</label>
            {form.unit === "st" ? (
              <div className="flex items-center gap-2">
                <input inputMode="numeric" value={form.st} onChange={e => set("st", e.target.value)} placeholder="st" disabled={form.fromLi} className={`${INPUT} disabled:opacity-60`} />
                <span className="text-xs text-slate-500">st</span>
                <input inputMode="decimal" value={form.lb} onChange={e => set("lb", e.target.value)} placeholder="lb" disabled={form.fromLi} className={`${INPUT} disabled:opacity-60`} />
                <span className="text-xs text-slate-500">lb</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input inputMode="decimal" value={form.single} onChange={e => set("single", e.target.value)} disabled={form.fromLi} className={`${INPUT} disabled:opacity-60`} />
                <span className="text-xs text-slate-500">{form.unit}</span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400">Goal date</label>
              <input type="date" value={form.fromLi && li ? li.date : form.goalAuto ? (earliest ?? form.goalDate) : form.goalDate} min={earliest ?? undefined} disabled={form.goalAuto || form.fromLi}
                onChange={e => set("goalDate", e.target.value)} className={`${INPUT} disabled:opacity-60`} />
              <label className="flex items-center gap-2 text-[11px] text-slate-400">
                <input type="checkbox" checked={form.goalAuto} disabled={form.fromLi} onChange={e => set("goalAuto", e.target.checked)} />
                Set automatically: the earliest date at the maximum loss rate, updated with each weigh-in
              </label>
              {tooSoon ? (
                <p className="text-[11px] text-rose-300">
                  Needs more than {limits?.maxLb ?? 2} lb a week. Earliest: {prettyDate(earliest!)}.{" "}
                  <button type="button" onClick={() => set("goalDate", earliest!)} className="underline hover:text-rose-200">Use it</button>
                </p>
              ) : (
                <p className="text-[11px] text-slate-500">
                  Max {limits?.maxLb ?? 2} lb a week{earliest ? `; earliest ${prettyDate(earliest)}` : ""}.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400">Daily calorie limit (kcal eaten)</label>
              <input inputMode="numeric" value={form.limit} onChange={e => set("limit", e.target.value)} placeholder="e.g. 2000" className={INPUT} />
            </div>
          </div>

          <details className="text-xs">
            <summary className="cursor-pointer text-slate-400 hover:text-slate-200">Projection settings</summary>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400">Base projections on the last N days</label>
                <input inputMode="numeric" value={form.trendDays} onChange={e => set("trendDays", e.target.value)} className={INPUT} />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400">kcal per kg of weight change</label>
                <input inputMode="numeric" value={form.kcalPerKg} onChange={e => set("kcalPerKg", e.target.value)} className={INPUT} />
              </div>
            </div>
            <p className="text-slate-500 mt-2">7,700 kcal per kg (about 3,500 per lb) is the usual estimate.</p>
          </details>

          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving || tooSoon}
              className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-medium px-4 py-2 text-white transition-colors"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {status && <span className={`text-xs ${status === "Saved." ? "text-slate-400" : "text-rose-300"}`}>{status}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
