import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0fdf4",
          500: "#22c55e",
          600: "#16a34a",
          700: "#15803d",
        },
      },
    },
  },
  safelist: [
    "bg-emerald-500", "bg-green-500", "bg-yellow-500", "bg-orange-500", "bg-red-500",
    "text-emerald-400", "text-green-400", "text-yellow-400", "text-orange-400", "text-red-400",
  ],
  plugins: [],
};

export default config;
