import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "מוטי – בוט המוטיבציה בוואטסאפ" },
      { name: "description", content: "סמל ציני וסרקסטי שרודף אחריך בוואטסאפ עד שתסגור את המשימות שלך." },
      { property: "og:title", content: "מוטי – בוט המוטיבציה בוואטסאפ" },
      { property: "og:description", content: "סמל ציני שרודף אחריך בוואטסאפ עד שתסגור מטרות." },
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
            "בוט מוטיבציה בוואטסאפ – סמל ציני וסרקסטי שרודף אחריך עד שתסגור מטרות.",
          applicationCategory: "ProductivityApplication",
          operatingSystem: "Web, WhatsApp",
          url: "https://moti-vation.lovable.app/",
          offers: { "@type": "Offer", price: "0", priceCurrency: "ILS" },
        }),
      },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <main dir="rtl" className="min-h-screen bg-[#0b141a] text-white flex items-center justify-center px-6 py-12">
      <div className="max-w-lg w-full text-center space-y-6">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-[#25d366] text-3xl font-bold shadow-lg">
          מ
        </div>
        <h1 className="text-3xl font-bold">מוטי חי בוואטסאפ</h1>
        <p className="text-gray-300 leading-relaxed">
          זה לא אתר. זה בוט. סמל קשוח, ציני וסרקסטי שרודף אחריך בוואטסאפ עד שתסגור את המשימות שלך.
        </p>
        <div className="rounded-xl border border-white/10 bg-white/5 p-5 text-right space-y-3">
          <h2 className="text-sm text-gray-400 font-normal">איך מתחילים:</h2>
          <ol className="space-y-2 text-gray-100 list-decimal pr-5">
            <li>שלח הודעת "היי" למוטי בוואטסאפ.</li>
            <li>ספר לו מה אתה דוחה או מתי להזכיר לך.</li>
            <li>תתכונן שיציק לך עד שתסגור.</li>
          </ol>
        </div>

        <a
          href="https://wa.me/972555030605?text=היי%20מוטי"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-full bg-[#25d366] px-8 py-4 text-lg font-bold text-[#0b141a] shadow-lg transition-transform hover:scale-105 active:scale-95"
        >
          <span>💬</span>
          דברו עם מוטי בוואטסאפ
        </a>

        <p className="text-sm text-gray-400">
          +972 55-503-0605
        </p>

        <p className="text-xs text-gray-500">
          חייבים לפתוח שיחה קודם בוואטסאפ כדי שהוא יוכל לשלוח הודעות בחזרה.
        </p>

        <p className="text-sm text-gray-400 pt-4 border-t border-white/10">
          <Link to="/blog/stop-procrastination-with-ai" className="underline hover:text-white">
            מדריך: איך להפסיק לדחות עם AI →
          </Link>
        </p>
      </div>
    </main>
  );
}
