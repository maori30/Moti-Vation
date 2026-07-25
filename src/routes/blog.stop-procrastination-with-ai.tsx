import { createFileRoute, Link } from "@tanstack/react-router";

const URL = "https://moti-vation.lovable.app/blog/stop-procrastination-with-ai";
const TITLE = "איך להפסיק לדחות עם AI: מדריך למי שסיים לשקר לעצמו";
const DESC =
  "מדריך מעשי איך להשתמש ב-AI ובבוט אחריותיות (כמו מוטי בוואטסאפ) כדי לשבור דחיינות, לבנות הרגלים ולסגור משימות.";

export const Route = createFileRoute("/blog/stop-procrastination-with-ai")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:type", content: "article" },
      { property: "og:url", content: URL },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: URL }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Article",
          headline: TITLE,
          description: DESC,
          url: URL,
          inLanguage: "he",
          author: { "@type": "Organization", name: "מוטי" },
          publisher: { "@type": "Organization", name: "מוטי" },
          datePublished: "2026-07-25",
          mainEntityOfPage: URL,
        }),
      },
    ],
  }),
  component: Post,
});

function Post() {
  return (
    <main dir="rtl" className="min-h-screen bg-[#0b141a] text-white px-6 py-12">
      <article className="mx-auto max-w-3xl space-y-6 leading-relaxed">
        <nav className="text-sm text-gray-400">
          <Link to="/" className="hover:text-white">← חזרה לדף הבית</Link>
        </nav>
        <header className="space-y-3">
          <h1 className="text-3xl font-bold">{TITLE}</h1>
          <p className="text-gray-300">
            דחיינות זו לא בעיה של אופי – זו בעיה של מערכת. AI פותר את זה בכך
            שהוא הופך אחריותיות למשהו שקורה אוטומטית, בלי להסתמך על כוח הרצון
            שלך שממילא נגמר בשעה 10 בבוקר.
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="text-2xl font-bold">למה בכלל דוחים?</h2>
          <p className="text-gray-200">
            המוח מעדיף רווח מיידי על פני רווח עתידי. משימה גדולה בלי תזכורת
            ובלי מישהו שיבדוק – שווה בפועל לאפס. אתה יודע שאתה צריך לעשות,
            אתה גם רוצה, אבל אין מנגנון שידחוף. זה בדיוק החור ש-AI ממלא.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-bold">3 דרכים ש-AI שובר דחיינות</h2>
          <ol className="list-decimal pr-5 space-y-2 text-gray-200">
            <li>
              <strong>פירוק אוטומטי של משימות:</strong> אומרים לבוט "אני צריך
              לסיים פרויקט", והוא מפרק את זה לצעדים קטנים עם דדליינים – בלי
              שאתה צריך לחשוב.
            </li>
            <li>
              <strong>תזכורות חכמות בזמן:</strong> לא alarm יבש בטלפון. הודעה
              עם קונטקסט: מה, למה, וכמה זמן זה יקח.
            </li>
            <li>
              <strong>אחריותיות (Accountability):</strong> החלק החשוב. בוט
              שמציק, מתעקש, ולא נותן לך להתחמק בתירוצים.
            </li>
          </ol>
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-bold">למה בוט מציק עובד טוב יותר</h2>
          <p className="text-gray-200">
            מחקרים על שינוי הרגלים מראים שאנשים שיש להם accountability partner
            מסיימים משימות בשיעור גבוה משמעותית. הבעיה: חברים ובני זוג לא זמינים
            24/7 ולא רוצים להציק לך. בוט AI כן.
          </p>
          <p className="text-gray-200">
            <strong>מוטי</strong> נבנה בדיוק על העיקרון הזה: בוט וואטסאפ עם
            אישיות של סמל קשוח, ציני, שרודף אחריך עד שאתה סוגר את המשימה. לא
            נעים – זו הפואנטה. אי-נעימות קטנה בהודעה שווה שעות של דחיינות
            שנחסכות.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-bold">איך להתחיל בפועל</h2>
          <ol className="list-decimal pr-5 space-y-2 text-gray-200">
            <li>בחר משימה אחת שאתה דוחה שבועיים.</li>
            <li>פרק אותה לצעד ראשון קטן – 10 דקות לכל היותר.</li>
            <li>שלח את זה לבוט אחריותיות עם שעה מדויקת.</li>
            <li>תן לו רשות להציק. באמת להציק.</li>
            <li>אחרי שסגרת – משימה חדשה. אותו נוהל.</li>
          </ol>
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-bold">שאלות נפוצות</h2>
          <h3 className="text-xl font-semibold">זה לא סתם עוד אפליקציית תזכורות?</h3>
          <p className="text-gray-200">
            תזכורת רגילה אומרת "היי, המשימה שלך". בוט AI אומר "מה נסגר, למה
            עוד לא התחלת, אני כאן עוד 30 דקות לבדוק". ההבדל הוא בטון ובעקביות.
          </p>
          <h3 className="text-xl font-semibold">מה אם אני מתעצבן מהבוט?</h3>
          <p className="text-gray-200">
            מצוין. עצבן = תגובה רגשית = פעולה. עדיף מלהיות אדיש ולא לעשות כלום.
          </p>
        </section>

        <section className="rounded-xl border border-white/10 bg-white/5 p-5 text-center space-y-3">
          <h2 className="text-2xl font-bold">מוכן לנסות?</h2>
          <p className="text-gray-300">מוטי מחכה בוואטסאפ. שלח "היי" ותתחיל.</p>
          <a
            href="https://wa.me/972555030605?text=היי%20מוטי"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-full bg-[#25d366] px-8 py-4 text-lg font-bold text-[#0b141a] shadow-lg transition-transform hover:scale-105 active:scale-95"
          >
            💬 דברו עם מוטי
          </a>
        </section>
      </article>
    </main>
  );
}