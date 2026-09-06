<truncated 780 lines>
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      const type = String(user.state).replace("awaiting_reminder_time_", "") as "once" | "daily" | "weekly";
      const due = israelTime(+time[1], +time[2]);
      await supabase.from("reminders").insert({ chat_id: chatId, text: user.pending_reminder_text, type, time: due.toISOString(), active: true });
      background(updateUser(chatId, { state: "idle", pending_reminder_text: null }), "reminder_time_state_reset");
      const manualLabel = reminderScheduleLabel(due, type);
      await sendMessage(chatId, pickReminderCreated(resolveActivePersonality(user), String(user.pending_reminder_text ?? "זה"), manualLabel));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const switchRequest = detectSwitchRequest(text);
    if (switchRequest?.type === "personality") {
      const changes = switchRequest.scope === "permanent"
        ? { personality: switchRequest.key, temp_personality: null, temp_personality_until: null }
        : { temp_personality: switchRequest.key, temp_personality_until: new Date(Date.now() + 2 * 3_600_000).toISOString() };
      background(updateUser(chatId, changes), "switch_personality");
      await sendMessage(chatId, `${PERSONALITIES[switchRequest.key]?.emoji ?? "💬"} סגור, לשעתיים הקרובות.`);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (switchRequest?.type === "tone") {
      background(updateUser(chatId, { tone_override: switchRequest.tone }), "switch_tone");
      await sendMessage(chatId, "סגור.");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (/^(\/reminders|התזכורות שלי|תזכורות)$/u.test(text)) {
      await showReminders(chatId);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (/(מחק|תמחק|לבטל|תבטל|הסר|תסיר)/u.test(text) && /(תזכור|כדור|אותה|אותו|ה)/u.test(text)) {
      const reminder = await findReminderForDeletion(chatId, text);
      if (reminder) {
        await askDeleteReminder(chatId, reminder);
      } else {
        await sendMessage(chatId, "איזו תזכורת למחוק? כתוב \"התזכורות שלי\" ובחר בכפתור.");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (detectDone(text)) {
      const { data: reminders } = await supabase.from("reminders").select("id, text").eq("chat_id", chatId).eq("active", true);
      const match = (reminders ?? []).find((reminder) => reminder.text.split(/\s+/).some((word: string) => word.length > 2 && text.includes(word)));
      if (match) {
        await sendMessage(chatId, `זה קשור ל"${match.text}"?`, { inline_keyboard: [[{ text: "✅ סיימתי", callback_data: `done_reminder_${match.id}` }, { text: "לא", callback_data: "dismiss" }]] });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    }

    if (detectReminderIntent(text)) {
      const parsed = parseReminder(text);
      if (parsed) {
        const { data: duplicates } = await supabase.from("reminders").select("id, text, type, time").eq("chat_id", chatId).eq("active", true);
        const duplicate = (duplicates ?? []).find((item) => item.text.trim().toLowerCase() === parsed.task.trim().toLowerCase() && item.type === parsed.type && Math.abs(new Date(item.time).getTime() - parsed.dueAt.getTime()) < 60_000);
        if (duplicate) {
          await sendMessage(chatId, `כבר יש לך תזכורת כזאת ל"${parsed.task}". לא הוספתי עוד אחת.`);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        await supabase.from("reminders").insert({ chat_id: chatId, text: parsed.task, type: parsed.type, time: parsed.dueAt.toISOString(), active: true });
        const label = reminderScheduleLabel(parsed.dueAt, parsed.type);
        await sendMessage(chatId, pickReminderCreated(personality, parsed.task, label));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      await sendMessage(chatId, "מתי להזכיר לך? למשל: מחר ב-8 או עוד שעה.");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const [histData, memRaw, profData, goalsData, eventsData, jokesData, phrasesData, remData] = await Promise.all([
      getHistory(chatId),
      fetchMemories(supabase, chatId),
      fetchProfile(supabase, chatId),
      fetchGoals(supabase, chatId),
      fetchEvents(supabase, chatId),
      fetchInsideJokes(supabase, chatId),
      fetchRecentPhrases(supabase, chatId),
      supabase.from("reminders").select("text").eq("chat_id", chatId).eq("active", true),
    ]);
    const history = histData;
    const memories = rankMemories(memRaw).slice(0, 5);
    const profile = profData;
    const goals = goalsData.slice(0, 3);
    const events = eventsData.slice(0, 3);
    const jokes = jokesData;
    const recentPhrases = phrasesData;

    const lastBot = [...history].reverse().find((item) => item.role === "assistant")?.content ?? "";
    const pace = computePacing(text, lastBot, profile);

    // Instant reply strictly for single laughter triggers ("חחח", "😂")
    if (pace.instantReply && isLaugh(text)) {
      await sendMessage(chatId, pace.instantReply);
      background(saveMessage(chatId, "user", text), "save_user_instant");
      background(saveMessage(chatId, "assistant", pace.instantReply), "save_assistant_instant");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const mode = /אין לי כוח|קשה לי|עייף|שרוף/.test(text) ? "frustration" : /סיימתי|עשיתי|הצלחתי/.test(text) ? "success" : "casual";
    const mood = pickMood(personality, { mode, hourLocal: new Date().getHours(), repeatStreak: 0, gapMinutes: 0, prevMood: user.mood });
    const humor = humorPolicy({ text, mode, tone: "neutral", intensity: 0, mood, userHumorLevel: profile.humor_level });
    const deep = detectDeepMode(text, history);
    const material = [...goals.map((g) => g.title), ...events.map((e) => e.title)];
    const surprise = rollSurprise(material.length > 0, deep.deep);
    const decision = decisionEngine({ text, pacing: pace, hasMemory: memories.length > 0, hasGoals: goals.length > 0, humorLevel: profile.humor_level, mood: moodLabel(mood) });

    const layers = [
      memoryContext(memories), confidenceContext(memories), profileContext(profile), goalContext(goals), eventContext(events), insideJokeContext(jokes),
      coreferenceInstruction(text, history), implicitIntentLayer(text, { events, goals, reminders: (remData.data ?? []).map((r: { text: string }) => r.text) }),
      moodInstruction(mood, 0), humor.instruction, toneOverrideInstruction(user.tone_override), followUpNudge(text), linkedReasoning(text, memories, goals, profile), selfCorrectionLayer(text, memories, goals),
      deep.deep ? deepModeInstruction(deep.topic) : pace.instruction, surpriseInstruction(surprise, material), antiRepetitionInstruction(recentPhrases), decision.layer,
    ];

    background(saveMessage(chatId, "user", text), "save_user");

    const reply = await askGemini(text, personality, history, "", layers);

    await sendMessage(chatId, reply);

    background(saveMessage(chatId, "assistant", reply), "save_assistant");
    background(rememberPhrase(supabase, chatId, reply), "remember_phrase");
    background(logBehavior(supabase, chatId, "message", { len: text.length }), "log_message");
    if (isLaugh(text)) background(logBehavior(supabase, chatId, "laughed"), "log_laughed");
    background(learnFromBehavior(supabase, chatId, profile), "learn_behavior");
    background(runBackgroundPipelines(chatId, text, reply, history, memories, profile), "pipelines");

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (error) {
    console.error("[telegram] fatal:", error);
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
});
