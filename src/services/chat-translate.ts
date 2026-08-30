type ChatLang = "en" | "zh";

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

export function detectChatLang(text: string): ChatLang {
  const sample = text.replace(/\s+/g, "");
  if (!sample) return "en";
  let cjk = 0;
  for (const ch of sample) {
    if (CJK_RE.test(ch)) cjk += 1;
  }
  return cjk / sample.length >= 0.2 ? "zh" : "en";
}

export function oppositeChatLang(lang: ChatLang): ChatLang {
  return lang === "zh" ? "en" : "zh";
}

export async function translateChatText(
  text: string,
  targetLang?: ChatLang,
): Promise<{ translatedText: string; sourceLang: ChatLang; targetLang: ChatLang }> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Nothing to translate");

  const sourceLang = detectChatLang(trimmed);
  const resolvedTarget = targetLang ?? oppositeChatLang(sourceLang);
  if (sourceLang === resolvedTarget) {
    return { translatedText: trimmed, sourceLang, targetLang: resolvedTarget };
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Translation unavailable — OPENAI_API_KEY is not configured");
  }

  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
  const targetLabel = resolvedTarget === "zh" ? "Simplified Chinese (Mandarin)" : "English";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You translate marketplace chat between English and Mandarin Chinese for cross-border trade. Preserve numbers, SKUs, currency symbols, and proper nouns. Return ONLY the translation with no quotes, labels, or commentary.",
        },
        {
          role: "user",
          content: `Translate the following message to ${targetLabel}:\n\n${trimmed}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Translation failed (${res.status})${errBody ? `: ${errBody.slice(0, 160)}` : ""}`);
  }

  const payload = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const translatedText = payload.choices?.[0]?.message?.content?.trim();
  if (!translatedText) throw new Error("Translation returned empty");

  return { translatedText, sourceLang, targetLang: resolvedTarget };
}
