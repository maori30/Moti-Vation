import { createFileRoute } from "@tanstack/react-router";

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
  }),
  component: Index,
});

function Index() {
  return (
    <div dir="rtl" className="min-h-screen bg-[#0b141a] text-white flex items-center justify-center px-6 py-12">
      <div className="max-w-lg w-full text-center space-y-6">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-[#25d366] text-3xl font-bold shadow-lg">
          מ
        </div>
        <h1 className="text-3xl font-bold">מוטי חי בוואטסאפ</h1>
        <p className="text-gray-300 leading-relaxed">
          זה לא אתר. זה בוט. סמל קשוח, ציני וסרקסטי שרודף אחריך בוואטסאפ עד שתסגור את המשימות שלך.
        </p>
        <div className="rounded-xl border border-white/10 bg-white/5 p-5 text-right space-y-3">
          <div className="text-sm text-gray-400">איך מתחילים:</div>
          <ol className="space-y-2 text-gray-100 list-decimal pr-5">
            <li>שלח הודעת "היי" למוטי בוואטסאפ.</li>
            <li>ספר לו מה אתה דוחה או מתי להזכיר לך.</li>
            <li>תתכונן שיציק לך עד שתסגור.</li>
          </ol>
        </div>
        <p className="text-xs text-gray-500">
          חייבים לפתוח שיחה קודם בוואטסאפ כדי שהוא יוכל לשלוח הודעות בחזרה.
        </p>
      </div>
    </div>
  );
}
