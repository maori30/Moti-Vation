import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "מוטי – בוט המוטיבציה בטלגרם" },
      { name: "description", content: "סמל ציני וסרקסטי שרודף אחריך בטלגרם עד שתסגור את המשימות שלך." },
      { property: "og:title", content: "מוטי – בוט המוטיבציה בטלגרם" },
      { property: "og:description", content: "סמל ציני שרודף אחריך בטלגרם עד שתסגור מטרות." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://moti-vation.lovable.app/" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "מוטי",
          description:
            "בוט מוטיבציה בטלגרם – סמל ציני וסרקסטי שרודף אחריך עד שתסגור מטרות.",
          applicationCategory: "ProductivityApplication",
          operatingSystem: "Web, Telegram",
          url: "https://moti-vation.lovable.app/",
          offers: { "@type": "Offer", price: "0", priceCurrency: "ILS" },
        }),
      },
    ],
  }),
  component: Index,
});

function Index() {
  const TELEGRAM_URL = "https://t.me/MotivationTheBot";
  return (
    <main
      dir="rtl"
      className="relative min-h-screen overflow-hidden text-white flex items-center justify-center px-4 py-10 sm:px-6 sm:py-16"
      style={{
        background:
          "radial-gradient(1200px 700px at 15% 10%, #1f6feb 0%, transparent 55%), radial-gradient(1000px 600px at 90% 90%, #29b6f6 0%, transparent 55%), radial-gradient(800px 500px at 60% 40%, #7c3aed 0%, transparent 60%), linear-gradient(180deg, #050914 0%, #0a0f1f 100%)",
      }}
    >
      {/* soft glow layers (gradient-based: no filter blur, so no GPU tiling seams) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(closest-side, rgba(56,189,248,0.28), rgba(56,189,248,0) 100%) 95% -5% / 60rem 40rem no-repeat, radial-gradient(closest-side, rgba(99,102,241,0.26), rgba(99,102,241,0) 100%) -10% 40% / 56rem 48rem no-repeat, radial-gradient(closest-side, rgba(217,70,239,0.18), rgba(217,70,239,0) 100%) 70% 105% / 48rem 36rem no-repeat",
        }}
      />

      <div className="relative z-10 w-full max-w-lg min-w-0">
        {/* Liquid glass card */}
        <div
          className="relative rounded-[1.75rem] sm:rounded-[2rem] p-6 sm:p-8 text-center space-y-5 sm:space-y-6 border border-white/15 shadow-[0_20px_80px_-20px_rgba(0,0,0,0.6)] backdrop-blur-2xl"
          style={{
            background:
              "linear-gradient(135deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.04) 60%, rgba(255,255,255,0.10) 100%)",
          }}
        >
          {/* glass highlight */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[1.75rem] sm:rounded-[2rem] overflow-hidden"
            style={{
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0) 55%)",
            }}
          />

          {/* Telegram glass badge */}
          <div className="relative mx-auto flex h-20 w-20 sm:h-24 sm:w-24 items-center justify-center rounded-full border border-white/30 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_10px_40px_-10px_rgba(41,182,246,0.7)]"
            style={{
              background:
                "linear-gradient(135deg, rgba(41,182,246,0.9) 0%, rgba(31,111,235,0.9) 100%)",
            }}
          >
            {/* Telegram paper plane */}
            <svg viewBox="0 0 24 24" className="h-10 w-10 sm:h-12 sm:w-12 drop-shadow" fill="white" aria-hidden>
              <path d="M9.036 15.803 8.86 19.3c.36 0 .518-.155.708-.34l1.7-1.63 3.523 2.58c.646.357 1.11.17 1.28-.598l2.32-10.87.001-.001c.203-.955-.345-1.329-.973-1.096L4.36 11.46c-.93.362-.916.881-.16 1.116l3.42 1.067 7.943-5.007c.374-.243.715-.108.435.135z"/>
            </svg>
          </div>

          <div className="relative space-y-3">
            <h1 className="text-[1.75rem] leading-tight sm:text-4xl font-bold tracking-tight bg-linear-to-b from-white to-white/70 bg-clip-text text-transparent">
              מוטי — 8 אישיויות, מטרה אחת: שתזוז
            </h1>
            <p className="text-sm sm:text-base text-white/80 leading-relaxed">
              בוחרים מי ידחוף אותך — רס"ר, ציני, מאמן, חבר, מטפל, מעודד, סבתא, פילוסוף, פראייר או השכן מלמעלה. שולחים מה דוחים, ומקבלים תזכורות בשעות ובימים שאתה בוחר, עד שזה נסגר.
            </p>
          </div>

          {/* Personalities */}
          <div className="relative flex flex-wrap justify-center gap-1.5 sm:gap-2">
            {[
              ["🪖", 'הרס"ר'],
              ["😈", "הציני"],
              ["🧠", "המאמן"],
              ["🤗", "החבר"],
              ["🛋️", "המטפל"],
              ["🔥", "המעודד"],
              ["👵", "הסבתא"],
              ["🧐", "הפילוסוף"],
              ["😏", "הפראייר"],
              ["🏠", "השכן מלמעלה"],
            ].map(([emoji, name]) => (
              <span
                key={name}
                className="whitespace-nowrap rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] sm:text-xs text-white/85 backdrop-blur-xl"
              >
                {emoji} {name}
              </span>
            ))}
          </div>

          {/* Steps glass panel */}
          <div className="relative rounded-2xl border border-white/15 bg-white/5 backdrop-blur-xl p-4 sm:p-5 text-right space-y-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]">
            <h2 className="text-xs uppercase tracking-widest text-white/60 font-normal">איך מתחילים</h2>
            <ol className="space-y-2 text-sm sm:text-base text-white/90 list-decimal pr-5 marker:text-sky-300">
              <li>לוחצים על הכפתור ופותחים את מוטי בטלגרם.</li>
              <li>שולחים /start ובוחרים את האישיות שמתאימה לך היום.</li>
              <li>אומרים מה דוחים ומתי להזכיר — והוא לוקח מכאן.</li>
            </ol>
          </div>

          {/* CTA — liquid glass button */}
          <a
            href={TELEGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="group relative inline-flex w-full items-center justify-center gap-2 sm:gap-3 rounded-full px-5 sm:px-8 py-3.5 sm:py-4 text-base sm:text-lg font-bold text-white border border-white/25 backdrop-blur-xl transition-all hover:scale-[1.02] active:scale-95 shadow-[0_10px_40px_-10px_rgba(41,182,246,0.8),inset_0_1px_0_rgba(255,255,255,0.4)]"
            style={{
              background:
                "linear-gradient(135deg, rgba(41,182,246,0.85) 0%, rgba(31,111,235,0.85) 100%)",
            }}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 sm:h-6 sm:w-6 shrink-0" fill="white" aria-hidden>
              <path d="M9.036 15.803 8.86 19.3c.36 0 .518-.155.708-.34l1.7-1.63 3.523 2.58c.646.357 1.11.17 1.28-.598l2.32-10.87c.203-.955-.345-1.329-.973-1.096L4.36 11.46c-.93.362-.916.881-.16 1.116l3.42 1.067 7.943-5.007c.374-.243.715-.108.435.135z"/>
            </svg>
            יאללה, בוא נתחיל בטלגרם
          </a>

          <p className="relative text-xs text-white/50">
            חינם, בלי הרשמה, 30 שניות ואתה בפנים.
          </p>

          <p className="relative text-sm text-white/60 pt-4 border-t border-white/10">
            <Link to="/blog/stop-procrastination-with-ai" className="underline decoration-sky-300/50 hover:text-white">
              מדריך: איך להפסיק לדחות עם AI ←
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
