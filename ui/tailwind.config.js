/** @type {import('tailwindcss').Config} */
import preset from "@sx/ui/tailwind-preset";

export default {
  presets: [preset],
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../../sx-ui/src/**/*.{ts,tsx}"],
};
