import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Standing Order — the subscription that can't overcharge you",
  description:
    "A trustless recurring-payment mandate on Solana: fund once, the provider pulls only up to a per-period cap, unused funds roll over, cancel refunds the rest.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
