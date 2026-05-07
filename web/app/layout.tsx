import type { Metadata, Viewport } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
import { Shell } from "@/components/layout/shell";
import { ToastProvider } from "@/components/system/toast-provider";
import { ErrorBoundary } from "@/components/system/error-boundary";
import { ThemeBootstrapScript } from "@/components/system/theme-toggle";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-source-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Spence — your chef-of-staff",
  description:
    "A chef-of-staff lives on your phone. Plans your week, walks you through tonight's cook, and quietly learns what you actually like.",
};

export const viewport: Viewport = {
  themeColor: "#F8F3EC",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${sourceSerif.variable}`}>
      <head>
        <ThemeBootstrapScript />
      </head>
      <body>
        <ErrorBoundary>
          <ToastProvider>
            <Shell>{children}</Shell>
          </ToastProvider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
