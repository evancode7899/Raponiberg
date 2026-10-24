import type { Metadata } from "next";
import Script from "next/script";
import { AppShell } from "@/components/shell/AppShell";
import { PREFERENCE_BOOTSTRAP_SCRIPT } from "@/components/shell/preferenceBootstrapScript";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Raponiberg", template: "%s · Raponiberg" },
  description: "Local personal finance workspace",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <Script id="pf-preference-bootstrap" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: PREFERENCE_BOOTSTRAP_SCRIPT }} />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
