// Client-safe. The day's macro targets: calories are the daily limit plus that day's exercise, protein is a
// fixed amount (g per kg of body weight), fat is a share of the calories and carbs take what is left.
export interface MacroPlan {
  proteinG: number | null; // proteinPerKg x the 7-day average weight
  fatPct: number;
  limitKcal: number | null; // the daily calorie limit
}

export interface MacroTargets { kcal: number; proteinG: number; fatG: number; carbsG: number }

export function macroTargets(plan: MacroPlan | null | undefined, exerciseKcal: number | null | undefined): MacroTargets | null {
  if (!plan || plan.proteinG == null || plan.limitKcal == null) return null;
  const kcal = plan.limitKcal + Math.max(exerciseKcal ?? 0, 0);
  const fatG = (kcal * plan.fatPct) / 100 / 9;
  const carbsG = Math.max(0, (kcal - plan.proteinG * 4 - fatG * 9) / 4);
  return { kcal, proteinG: plan.proteinG, fatG, carbsG };
}
