import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useMotiState, applyToolCall } from "@/lib/moti-store";
import { Send, Target, Bell, Trash2, Check, MoreVertical } from "lucide-react";

const DAY_LABELS: Record<string, string> = {
  sun: "א׳",
  mon: "ב׳",
  tue: "ג׳",
  wed: "ד׳",
  thu: "ה׳",
  fri: "ו׳",
  sat: "ש׳",
};
const DAY_INDEX = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}

function extractText(message: UIMessage): string {
  return message.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();
}

export function MotiChat() {
  const { state, setState, hydrated, reset } = useMotiState();
  const [input, setInput] = useState("");
  const [showPanel, setShowPanel] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat" }), []);

  const { messages, sendMessage, status, setMessages } = useChat({
    id: "moti-main",
    transport,
    messages: state.messages,
  });

  // Load persisted messages on hydration
  useEffect(() => {
    if (hydrated && state.messages.length > 0 && messages.length === 0) {
      setMessages(state.messages);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  // Persist messages + apply tool calls
  const appliedToolIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!hydrated) return;
    let newState = state;
    let changed = false;

    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const part of m.parts) {
        const anyPart = part as unknown as {
          type: string;
          toolCallId?: string;
          toolName?: string;
          input?: Record<string, unknown>;
          state?: string;
        };
        if (
          anyPart.type &&
          anyPart.type.startsWith("tool-") &&
          anyPart.toolCallId &&
          anyPart.input &&
          !appliedToolIds.current.has(anyPart.toolCallId)
        ) {
          const toolName = anyPart.type.replace(/^tool-/, "");
          appliedToolIds.current.add(anyPart.toolCallId);
          newState = applyToolCall(newState, toolName, anyPart.input);
          changed = true;
        }
      }
    }

    if (changed || newState.messages !== messages) {
      setState({ ...newState, messages });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, hydrated]);

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, status]);

  // Focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, [status]);

  // Send state with each request
  const handleSend = () => {
    if (!input.trim() || status === "streaming" || status === "submitted") return;
    const now = new Date().toISOString();
    sendMessage(
      { text: input.trim() },
      {
        body: {
          state: {
            goals: state.goals,
            reminders: state.reminders,
            now,
          },
        },
      },
    );
    setInput("");
  };

  // Reminder loop – check every 30s
  const firedOnce = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!hydrated) return;
    const tick = () => {
      const now = new Date();
      const todayKey = now.toISOString().slice(0, 10);
      const dayCode = DAY_INDEX[now.getDay()];
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

      let updated = false;
      const nextReminders = state.reminders.map((r) => {
        if (r.kind === "once" && r.at && !firedOnce.current.has(r.id)) {
          if (new Date(r.at).getTime() <= now.getTime()) {
            firedOnce.current.add(r.id);
            fireReminder(r.text);
          }
        }
        if (r.kind === "recurring" && r.time && r.days) {
          if (r.days.includes(dayCode) && r.time === hhmm && r.lastFired !== todayKey) {
            fireReminder(r.text);
            updated = true;
            return { ...r, lastFired: todayKey };
          }
        }
        return r;
      });
      if (updated) setState({ ...state, reminders: nextReminders });
    };
    const id = window.setInterval(tick, 30_000);
    tick();
    return () => window.clearInterval(id);
  }, [state, hydrated, setState]);

  const fireReminder = (text: string) => {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("מוטי – תזכורת", { body: text });
    }
    // Send a sarcastic WhatsApp nudge if the user configured a phone
    if (state.phone && state.phone.trim().length >= 6) {
      fetch("/api/send-reminder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: state.phone.trim(), text }),
      }).catch((e) => console.error("send-reminder failed", e));
    }
    // Trigger the bot to nag about it
    sendMessage(
      {
        text: `[SYSTEM_REMINDER_FIRED] תזכורת: "${text}" – תפתח, תעקוץ אותי אם עוד לא עשיתי, בלי לחזור על הטקסט מילה במילה.`,
      },
      {
        body: {
          state: {
            goals: state.goals,
            reminders: state.reminders,
            now: new Date().toISOString(),
          },
        },
      },
    );
  };

  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  const openGoals = state.goals.filter((g) => !g.done);

  return (
    <div className="flex h-screen w-full flex-col bg-[url('https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png')] bg-repeat">
      <style>{`
        .whatsapp-bg { background-color: #efeae2; }
        .bubble-bot { background: #ffffff; }
        .bubble-user { background: #d9fdd3; }
      `}</style>

      {/* Header */}
      <header className="flex items-center justify-between gap-3 bg-[#075e54] px-4 py-3 text-white shadow">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#128c7e] text-lg font-bold">
            מ
          </div>
          <div>
            <div className="font-semibold leading-tight">מוטי</div>
            <div className="text-xs opacity-80">מציק לך עד שתסגור מטרות</div>
          </div>
        </div>
        <button
          onClick={() => setShowPanel((v) => !v)}
          className="flex items-center gap-2 rounded-full p-2 hover:bg-white/10"
          aria-label="פאנל מטרות"
        >
          {openGoals.length > 0 && (
            <span className="rounded-full bg-[#25d366] px-2 py-0.5 text-xs font-bold">
              {openGoals.length}
            </span>
          )}
          <MoreVertical size={20} />
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Chat */}
        <div className="flex flex-1 flex-col whatsapp-bg">
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 sm:px-6">
            <div className="mx-auto flex max-w-2xl flex-col gap-2">
              {messages.length === 0 && (
                <div className="my-8 rounded-lg bg-white/80 p-4 text-center text-sm text-gray-600 shadow-sm">
                  אהלן, אני מוטי. תרשום לי מטרה או משימה שאתה דוחה, ואני אשב לך על הווריד עד שתסגור.
                  <br />
                  יאללה, מה יש היום?
                </div>
              )}
              {messages.map((m) => {
                const text = extractText(m);
                const isUser = m.role === "user";
                // Hide system-injected reminder triggers
                if (isUser && text.startsWith("[SYSTEM_REMINDER_FIRED]")) return null;
                const toolBadges = m.parts
                  .filter((p) => (p as { type: string }).type.startsWith("tool-"))
                  .map((p, i) => {
                    const anyP = p as unknown as { type: string; input?: Record<string, unknown> };
                    const name = anyP.type.replace(/^tool-/, "");
                    const label = renderToolBadge(name, anyP.input ?? {});
                    return label ? (
                      <div
                        key={i}
                        className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#25d366]/15 px-2 py-0.5 text-xs text-[#075e54]"
                      >
                        {label}
                      </div>
                    ) : null;
                  });
                if (!text && toolBadges.every((b) => !b)) return null;
                return (
                  <div
                    key={m.id}
                    className={`flex ${isUser ? "justify-start" : "justify-end"}`}
                  >
                    <div
                      className={`relative max-w-[85%] rounded-lg px-3 py-2 text-sm shadow-sm ${
                        isUser ? "bubble-user" : "bubble-bot"
                      }`}
                      style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                    >
                      <div className="text-[15px] leading-relaxed text-gray-900">{text}</div>
                      <div className="flex flex-wrap gap-1">{toolBadges}</div>
                      <div className="mt-1 text-[10px] text-gray-500">
                        {formatTime(new Date().toISOString())}
                      </div>
                    </div>
                  </div>
                );
              })}
              {(status === "submitted" || status === "streaming") && (
                <div className="flex justify-end">
                  <div className="bubble-bot rounded-lg px-3 py-2 text-sm shadow-sm">
                    <span className="inline-flex gap-1">
                      <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.3s]" />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.15s]" />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400" />
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Composer */}
          <div className="bg-[#f0f2f5] px-3 py-2 sm:px-6">
            <div className="mx-auto flex max-w-2xl items-end gap-2">
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="כתוב הודעה"
                className="flex-1 resize-none rounded-full bg-white px-4 py-2 text-[15px] outline-none placeholder:text-gray-400 focus:ring-2 focus:ring-[#25d366]/40"
                style={{ maxHeight: 120 }}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || status === "streaming" || status === "submitted"}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-[#25d366] text-white shadow disabled:opacity-40"
                aria-label="שלח"
              >
                <Send size={18} className="rotate-180" />
              </button>
            </div>
          </div>
        </div>

        {/* Side panel */}
        {showPanel && (
          <aside className="hidden w-80 flex-col border-r border-gray-200 bg-white md:flex">
            <PanelContent state={state} setState={setState} onReset={reset} />
          </aside>
        )}
      </div>

      {/* Mobile bottom sheet */}
      {showPanel && (
        <div
          className="fixed inset-0 z-50 flex md:hidden"
          onClick={() => setShowPanel(false)}
        >
          <div className="mr-auto h-full w-80 max-w-[85%] bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <PanelContent state={state} setState={setState} onReset={reset} onClose={() => setShowPanel(false)} />
          </div>
        </div>
      )}
    </div>
  );
}

function renderToolBadge(name: string, input: Record<string, unknown>): string | null {
  const text = typeof input.text === "string" ? input.text : "";
  switch (name) {
    case "add_goal":
      return `🎯 נוספה מטרה: ${text}`;
    case "complete_goal":
      return `✅ מטרה הושלמה: ${text}`;
    case "remove_goal":
      return `🗑️ מטרה נמחקה: ${text}`;
    case "add_reminder": {
      if (input.kind === "recurring") {
        const days = Array.isArray(input.days)
          ? (input.days as string[]).map((d) => DAY_LABELS[d] ?? d).join(",")
          : "";
        return `⏰ תזכורת חוזרת ${days} ${input.time ?? ""}: ${text}`;
      }
      const at = typeof input.at === "string" ? new Date(input.at) : null;
      const when = at
        ? at.toLocaleString("he-IL", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      return `⏰ תזכורת ${when}: ${text}`;
    }
    case "remove_reminder":
      return `🗑️ תזכורת נמחקה: ${text}`;
    default:
      return null;
  }
}

function PanelContent({
  state,
  setState,
  onReset,
  onClose,
}: {
  state: ReturnType<typeof useMotiState>["state"];
  setState: ReturnType<typeof useMotiState>["setState"];
  onReset: () => void;
  onClose?: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <div className="font-semibold">מטרות ותזכורות</div>
        {onClose && (
          <button onClick={onClose} className="text-sm text-gray-500">
            סגור
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-4 text-sm">
        <div className="mb-6 rounded-md border border-[#25d366]/30 bg-[#25d366]/5 p-3">
          <label className="mb-1 block text-xs font-semibold text-[#075e54]">
            מספר וואטסאפ לתזכורות
          </label>
          <input
            type="tel"
            dir="ltr"
            placeholder="+972501234567"
            value={state.phone ?? ""}
            onChange={(e) => setState({ ...state, phone: e.target.value })}
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#25d366]"
          />
          <div className="mt-1 text-[11px] leading-tight text-gray-500">
            אפשר גם 05... – ייהפך אוטומטית ל־972. חייבים לפתוח שיחה קודם מולי בוואטסאפ כדי שההודעות יעברו.
          </div>
          {state.phone && state.phone.trim().length >= 6 && (
            <button
              onClick={async () => {
                const res = await fetch("/api/send-reminder", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    phone: state.phone!.trim(),
                    text: "בדיקת חיבור למוטי",
                  }),
                });
                const data = await res.json().catch(() => ({}));
                alert(res.ok ? "יצא. תבדוק וואטסאפ." : `נפל: ${JSON.stringify(data).slice(0, 300)}`);
              }}
              className="mt-2 w-full rounded-md bg-[#25d366] py-1.5 text-xs font-semibold text-white hover:bg-[#1ebe57]"
            >
              שלח הודעת בדיקה
            </button>
          )}
        </div>

        <div className="mb-3 flex items-center gap-2 text-[#075e54]">
          <Target size={16} /> <span className="font-semibold">מטרות פתוחות</span>
        </div>
        {state.goals.filter((g) => !g.done).length === 0 ? (
          <div className="mb-6 text-gray-500">אין מטרות פתוחות. חבל, אה?</div>
        ) : (
          <ul className="mb-6 space-y-2">
            {state.goals
              .filter((g) => !g.done)
              .map((g) => (
                <li
                  key={g.id}
                  className="flex items-center justify-between gap-2 rounded-md bg-gray-50 px-3 py-2"
                >
                  <span className="flex-1">{g.text}</span>
                  <button
                    className="text-green-600"
                    onClick={() =>
                      setState({
                        ...state,
                        goals: state.goals.map((x) =>
                          x.id === g.id ? { ...x, done: true } : x,
                        ),
                      })
                    }
                    aria-label="סמן כהושלם"
                  >
                    <Check size={16} />
                  </button>
                  <button
                    className="text-red-500"
                    onClick={() =>
                      setState({
                        ...state,
                        goals: state.goals.filter((x) => x.id !== g.id),
                      })
                    }
                    aria-label="מחק"
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
          </ul>
        )}

        <div className="mb-3 flex items-center gap-2 text-[#075e54]">
          <Bell size={16} /> <span className="font-semibold">תזכורות</span>
        </div>
        {state.reminders.length === 0 ? (
          <div className="mb-6 text-gray-500">אין תזכורות. בקש ממני להוסיף.</div>
        ) : (
          <ul className="mb-6 space-y-2">
            {state.reminders.map((r) => (
              <li
                key={r.id}
                className="flex items-start justify-between gap-2 rounded-md bg-gray-50 px-3 py-2"
              >
                <div className="flex-1">
                  <div>{r.text}</div>
                  <div className="text-xs text-gray-500">
                    {r.kind === "once"
                      ? r.at &&
                        new Date(r.at).toLocaleString("he-IL", {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : `${r.days?.map((d) => DAY_LABELS[d] ?? d).join(",")} · ${r.time}`}
                  </div>
                </div>
                <button
                  className="text-red-500"
                  onClick={() =>
                    setState({
                      ...state,
                      reminders: state.reminders.filter((x) => x.id !== r.id),
                    })
                  }
                  aria-label="מחק"
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {state.goals.some((g) => g.done) && (
          <>
            <div className="mb-2 text-xs font-semibold uppercase text-gray-500">הושלמו</div>
            <ul className="mb-6 space-y-1 text-gray-500">
              {state.goals
                .filter((g) => g.done)
                .map((g) => (
                  <li key={g.id} className="line-through">
                    {g.text}
                  </li>
                ))}
            </ul>
          </>
        )}

        <button
          onClick={() => {
            if (confirm("למחוק הכל?")) onReset();
          }}
          className="mt-4 w-full rounded-md border border-red-200 py-2 text-sm text-red-600 hover:bg-red-50"
        >
          איפוס מלא
        </button>
      </div>
    </div>
  );
}