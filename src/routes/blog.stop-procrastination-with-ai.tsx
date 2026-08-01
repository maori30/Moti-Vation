import { createFileRoute, Link } from "@tanstack/react-router";

const URL = "https://moti-vation.lovable.app/blog/stop-procrastination-with-ai";
const TITLE = "איך להפסיק לדחות עם AI: מדריך למי שסיים לשקר לעצמו";
const DESC =
  "מדריך מעשי איך להשתמש ב-AI ובבוט אחריותיות בטלגרם (מוטי) כדי לשבור דחיינות, לבנות הרגלים ולסגור משימות.";

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
          <h2 className="text-2xl font-bold">למה בוט שמזכיר לך עובד טוב יותר</h2>
          <p className="text-gray-200">
            כשיש מישהו שבודק אם עשית – הסיכוי שתעשה עולה. הבעיה: חברים ובני זוג
            לא זמינים 24/7 ולא באמת רוצים להציק לך. בוט כן.
          </p>
          <p className="text-gray-200">
            <strong>מוטי</strong> נבנה בדיוק על העיקרון הזה – בוט טלגרם עם 8
            אישיויות שאתה בוחר ביניהן: הרס"ר שדוחף בלי רחמים, הצייני עם הסרקזם,
            המאמן, החבר, המטפל, המעודד, הסבתא והפילוסוף. אותה מטרה, טון אחר –
            כי לכל אחד עובד משהו אחר, ובימים שונים עובד משהו אחר.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-bold">איזו אישיות מתאימה לך?</h2>
          <ul className="list-disc pr-5 space-y-2 text-gray-200">
            <li><strong>🪖 הרס"ר</strong> – כשאתה צריך שמישהו יצעק ולא ישאל איך אתה מרגיש.</li>
            <li><strong>😈 הצייני</strong> – סרקזם יבש שמפרק לך את התירוצים.</li>
            <li><strong>🧠 המאמן</strong> – מפרק משימות לצעדים והולך איתך שלב-שלב.</li>
            <li><strong>🤗 החבר</strong> – טון קליל, בלי לחץ, אבל לא שוכח.</li>
            <li><strong>🛋️ המטפל</strong> – כשהדחיינות היא באמת חרדה ולא עצלנות.</li>
            <li><strong>🔥 המעודד</strong> – התלהבות מוגזמת שמזיזה אותך מהכיסא.</li>
            <li><strong>👵 הסבתא</strong> – חמימות עם אשמה קטנה במקומות הנכונים.</li>
            <li><strong>🧐 הפילוסוף</strong> – שאלות שגורמות לך להבין למה אתה בורח.</li>
          </ul>
          <p className="text-gray-200">
            אפשר להחליף בכל רגע עם <code>/personality</code>.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-2xl font-bold">איך להתחיל בפועל</h2>
          <ol className="list-decimal pr-5 space-y-2 text-gray-200">
            <li>פתח את מוטי בטלגרם ושלח /start.</li>
            <li>בחר אישיות שמתאימה לך עכשיו.</li>
            <li>בחר משימה אחת שאתה דוחה שבועיים.</li>
            <li>פרק אותה לצעד ראשון קטן – 10 דקות לכל היותר.</li>
            <li>תגיד לו מתי להזכיר – שעה, יום בשבוע, או "תציק לי עד שאעשה".</li>
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
            אז מחליפים אישיות. אם הרס"ר יותר מדי – עוברים לחבר או למאמן. הרעיון
            הוא למצוא את הטון שגורם לך לזוז, לא להיאבק בבוט.
          </p>
        </section>

        <section className="rounded-xl border border-white/10 bg-white/5 p-5 text-center space-y-3">
          <h2 className="text-2xl font-bold">מוכן לנסות?</h2>
          <p className="text-gray-300">מוטי מחכה בטלגרם. שלח /start ותבחר מי ידחוף אותך.</p>
          <a
            href="https://t.me/MotivationTheBot"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-full bg-[#29b6f6] px-8 py-4 text-lg font-bold text-[#06131f] shadow-lg transition-transform hover:scale-105 active:scale-95"
          >
            ✈️ פתח את מוטי בטלגרם
          </a>
        </section>
      </article>
    </main>
  );
}