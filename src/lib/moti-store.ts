import { useEffect, useState, useCallback } from "react";
import type { UIMessage } from "ai";

export type Goal = { id: string; text: string; done?: boolean };
export type Reminder = {
  id: string;
  text: string;
  kind: "once" | "recurring" | "nag";
  at?: string; // ISO
  time?: string; // HH:MM
  days?: string[]; // sun..sat
  nag_every_min?: number;
  nag_until?: string;
  lastFired?: string; // ISO date "YYYY-MM-DD" for recurring dedupe
};

export type MotiState = {
  goals: Goal[];
  reminders: Reminder[];
  messages: UIMessage[];
  phone?: string; // WhatsApp destination E.164-ish
};

const KEY = "moti-state-v1";

function load(): MotiState {
  if (typeof window === "undefined") return { goals: [], reminders: [], messages: [] };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { goals: [], reminders: [], messages: [] };
    return JSON.parse(raw) as MotiState;
  } catch {
    return { goals: [], reminders: [], messages: [] };
  }
}

function save(state: MotiState) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
}

export function useMotiState() {
  const [state, setState] = useState<MotiState>(() => ({ goals: [], reminders: [], messages: [] }));
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setState(load());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) save(state);
  }, [state, hydrated]);

  const reset = useCallback(() => {
    setState({ goals: [], reminders: [], messages: [] });
  }, []);

  return { state, setState, hydrated, reset };
}

export function applyToolCall(
  state: MotiState,
  name: string,
  input: Record<string, unknown>,
): MotiState {
  const text = typeof input.text === "string" ? input.text : "";
  switch (name) {
    case "add_goal": {
      if (!text) return state;
      if (state.goals.some((g) => g.text === text && !g.done)) return state;
      return { ...state, goals: [...state.goals, { id: crypto.randomUUID(), text }] };
    }
    case "complete_goal": {
      return {
        ...state,
        goals: state.goals.map((g) => (g.text === text ? { ...g, done: true } : g)),
      };
    }
    case "remove_goal": {
      return { ...state, goals: state.goals.filter((g) => g.text !== text) };
    }
    case "add_reminder": {
      const kind =
        input.kind === "recurring" ? "recurring" : input.kind === "nag" ? "nag" : "once";
      const rem: Reminder = {
        id: crypto.randomUUID(),
        text,
        kind,
        at: typeof input.at === "string" ? input.at : undefined,
        time: typeof input.time === "string" ? input.time : undefined,
        days: Array.isArray(input.days) ? (input.days as string[]) : undefined,
        nag_every_min:
          typeof input.nag_every_min === "number" ? input.nag_every_min : undefined,
        nag_until: typeof input.nag_until === "string" ? input.nag_until : undefined,
      };
      return { ...state, reminders: [...state.reminders, rem] };
    }
    case "remove_reminder": {
      return { ...state, reminders: state.reminders.filter((r) => r.text !== text) };
    }
    default:
      return state;
  }
}