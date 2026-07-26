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
      className="relative min-h-screen overflow-hidden text-white flex items-center justify-center px-6 py-16"
      style={{
        background:
          "radial-gradient(1200px 700px at 15% 10%, #1f6feb 0%, transparent 55%), radial-gradient(1000px 600px at 90% 90%, #29b6f6 0%, transparent 55%), radial-gradient(800px 500px at 60% 40%, #7c3aed 0%, transparent 60%), linear-gradient(180deg, #050914 0%, #0a0f1f 100%)",
      }}
    >
      {/* floating blobs */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-24 -right-24 h-96 w-96 rounded-full bg-sky-400/30 blur-3xl animate-pulse" />
        <div className="absolute top-1/3 -left-32 h-[28rem] w-[28rem] rounded-full bg-indigo-500/30 blur-3xl" />
        <div className="absolute -bottom-24 right-1/4 h-80 w-80 rounded-full bg-fuchsia-500/20 blur-3xl" />
      </div>

      <div className="relative z-10 max-w-lg w-full">
        {/* Liquid glass card */}
        <div
          className="relative rounded-[2rem] p-8 text-center space-y-6 border border-white/15 shadow-[0_20px_80px_-20px_rgba(0,0,0,0.6)] backdrop-blur-2xl"
          style={{
            background:
              "linear-gradient(135deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.04) 60%, rgba(255,255,255,0.10) 100%)",
          }}
        >
          {/* glass highlight */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[2rem]"
            style={{
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.28) 0%, rgba(255,255,255,0) 40%)",
              maskImage:
                "linear-gradient(180deg, black 0%, transparent 60%)",
            }}
          />

          {/* Telegram glass badge */}
          <div className="relative mx-auto flex h-24 w-24 items-center justify-center rounded-full border border-white/30 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_10px_40px_-10px_rgba(41,182,246,0.7)]"
            style={{
              background:
                "linear-gradient(135deg, rgba(41,182,246,0.9) 0%, rgba(31,111,235,0.9) 100%)",
            }}
          >
            {/* Telegram paper plane */}
            <svg viewBox="0 0 24 24" className="h-12 w-12 drop-shadow" fill="white" aria-hidden>
              <path d="M9.036 15.803 8.86 19.3c.36 0 .518-.155.708-.34l1.7-1.63 3.523 2.58c.646.357 1.11.17 1.28-.598l2.32-10.87.001-.001c.203-.955-.345-1.329-.973-1.096L4.36 11.46c-.93.362-.916.881-.16 1.116l3.42 1.067 7.943-5.007c.374-.243.715-.108.435.135z"/>
            </svg>
          </div>

          <div className="relative space-y-3">
            <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-b from-white to-white/70 bg-clip-text text-transparent">
              מוטי חי בטלגרם
            </h1>
            <p className="text-white/80 leading-relaxed">
              זה לא אתר. זה בוט. סמל קשוח, ציני וסרקסטי שרודף אחריך בטלגרם עד שתסגור את המשימות שלך.
            </p>
          </div>

          {/* Steps glass panel */}
          <div className="relative rounded-2xl border border-white/15 bg-white/5 backdrop-blur-xl p-5 text-right space-y-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]">
            <h2 className="text-xs uppercase tracking-widest text-white/60 font-normal">איך מתחילים</h2>
            <ol className="space-y-2 text-white/90 list-decimal pr-5 marker:text-sky-300">
              <li>לחץ על הכפתור ופתח את מוטי בטלגרם.</li>
              <li>שלח /start וספר לו מה אתה דוחה.</li>
              <li>תתכונן — הוא לא יעזוב אותך עד שתסגור.</li>
            </ol>
          </div>

          {/* CTA — liquid glass button */}
          <a
            href={TELEGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="group relative inline-flex w-full items-center justify-center gap-3 rounded-full px-8 py-4 text-lg font-bold text-white border border-white/25 backdrop-blur-xl transition-all hover:scale-[1.02] active:scale-95 shadow-[0_10px_40px_-10px_rgba(41,182,246,0.8),inset_0_1px_0_rgba(255,255,255,0.4)]"
            style={{
              background:
                "linear-gradient(135deg, rgba(41,182,246,0.85) 0%, rgba(31,111,235,0.85) 100%)",
            }}
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="white" aria-hidden>
              <path d="M9.036 15.803 8.86 19.3c.36 0 .518-.155.708-.34l1.7-1.63 3.523 2.58c.646.357 1.11.17 1.28-.598l2.32-10.87c.203-.955-.345-1.329-.973-1.096L4.36 11.46c-.93.362-.916.881-.16 1.116l3.42 1.067 7.943-5.007c.374-.243.715-.108.435.135z"/>
            </svg>
            פתח את מוטי בטלגרם
          </a>

          <p className="relative text-xs text-white/50">
            חינם. בלי הרשמה. בלי בולשיט.
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
