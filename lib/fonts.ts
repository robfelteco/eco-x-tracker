// Eco house-style fonts. Roobert (Trial weight) for sans; JetBrains Mono stands
// in for Aeonik Mono, used all-caps for labels/eyebrows/figures.
import localFont from "next/font/local";
import { JetBrains_Mono } from "next/font/google";

export const roobert = localFont({
  src: "../fonts/Roobert.otf",
  variable: "--font-roobert",
  display: "swap",
});

export const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jbmono",
  display: "swap",
});
