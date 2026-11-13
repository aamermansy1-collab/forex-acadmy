import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

// خط عربي حديث (Cairo) — يدعم العربية بأوزان متعددة.
const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "مولّد الوسائط MCP | إدارة المفاتيح والمهام والدمج",
  description:
    "خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي مع تبديل تلقائي للمفاتيح، ودمج المقاطع، ولوحة إدارة عربية.",
  keywords: ["MCP", "توليد صور", "توليد فيديو", "kie.ai", "دمج فيديو", "Turso"],
  authors: [{ name: "MCP Media Generator" }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // RTL + lang=ar من أول لحظة.
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body className={`${cairo.variable} font-sans antialiased bg-background text-foreground`}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
