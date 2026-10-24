// Озвучки для Зиры. Она присылает в личку Николаю ссылку на Google Doc с текстом
// ролика (медтехника B.Well), а через Telegram Business сообщение видит и бот:
// достаёт текст → спрашивает Николая «озвучиваю?» → делает два варианта голосом
// Liam в ElevenLabs → присылает Николаю послушать → по кнопке отправляет Зире
// от его имени с подписью агента.

import { InputFile } from "grammy";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const docsBase = () => process.env.GDOCS_BASE || "https://docs.google.com";
const elevenBase = () => process.env.ELEVEN_API_BASE || "https://api.elevenlabs.io";

// Голос и настройки — как в августовских озвучках B.Well, которые Зира приняла
export const VOICE = {
  id: process.env.VOICEOVER_VOICE_ID || "TX3LPaxmHKxFdv7VOQHJ", // Liam - Energetic, Social Media Creator
  name: "Liam",
  model: "eleven_multilingual_v2",
  settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1.0 },
};

export const SIGNATURE = "🤖 Skynet_HA_hA_666, ИИ-агент Николая";
const TTS_CHUNK = 9000; // у multilingual_v2 лимит 10 000 знаков на запрос

export function docIdFrom(text) {
  return text?.match(/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([\w-]{20,})/)?.[1] || null;
}

// Текст дока целиком. Закрытый доступ Google отдаёт страницей входа — это ошибка.
export async function fetchDocText(id) {
  const res = await fetch(`${docsBase()}/document/d/${id}/export?format=txt`, { redirect: "follow" });
  const type = res.headers.get("content-type") || "";
  if (!res.ok || type.includes("text/html")) {
    const e = new Error(`док не открылся (HTTP ${res.status})`);
    e.closed = true;
    throw e;
  }
  return (await res.text()).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

export function paragraphs(text) {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

const LANG_MARK =
  /^(язык|language|lang|озвучка|озвучить|voice[- ]?over|текст для озвучки)?\s*[:\-–]?\s*(на\s+)?(english|eng|en|английск\w*|англ\.?|russian|rus|ru|русск\w*|german|deutsch|de|немецк\w*|french|fr|французск\w*|spanish|es|испанск\w*|italian|it|итальянск\w*|kazakh|kz|казахск\w*|uzbek|uz|узбекск\w*)(\s+(язык|language|version|версия))?\s*[.:!]?$/i;

function guessLang(text) {
  const cyr = (text.match(/[а-яё]/gi) || []).length;
  const lat = (text.match(/[a-z]/gi) || []).length;
  return cyr > lat ? "ru" : "en";
}

// Запасной разбор без Клода: выкинуть пометки языка и короткий заголовок первой строкой
export function fallbackPick(paras) {
  const voice = [];
  const excluded = [];
  paras.forEach((p, i) => {
    const titleLike = i === 0 && paras.length > 1 && p.length <= 40 && !/[.!?…]$/.test(p);
    if (LANG_MARK.test(p) || titleLike) excluded.push(i);
    else voice.push(i);
  });
  return { voice, excluded, title: excluded.includes(0) ? paras[0] : "", language: guessLang(paras.join(" ")) };
}

// Клод возвращает НОМЕРА абзацев, а не текст: озвучиваем ровно то, что прислала Зира,
// без единого переписанного слова. Ответ проверяем и при любой странности берём запасной разбор.
export async function pickVoiceText(paras, selector) {
  let pick = null;
  if (selector) {
    try {
      const numbered = paras.map((p, i) => `[${i + 1}] ${p}`).join("\n");
      const raw = await selector(numbered);
      const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      const voice = [...new Set((json.voice || []).map((n) => Number(n) - 1))]
        .filter((i) => Number.isInteger(i) && i >= 0 && i < paras.length)
        .sort((a, b) => a - b);
      if (voice.length) {
        pick = {
          voice,
          excluded: paras.map((_, i) => i).filter((i) => !voice.includes(i)),
          title: String(json.title || "").trim(),
          language: String(json.language || "").trim().toLowerCase() || guessLang(paras.join(" ")),
        };
      }
    } catch (e) {
      console.error("Разбор текста озвучки Клодом не удался:", e.message);
    }
  }
  pick ||= fallbackPick(paras);
  return { ...pick, text: pick.voice.map((i) => paras[i]).join("\n") };
}

// Как Liam читает правильно — выверено на озвучках B.Well (24.10.2026)
export function pronounce(text, language = "en") {
  if (!/^en/.test(language)) return text;
  return text
    .replace(/\bB\.\s?Well\b/g, "Be Well")
    .replace(/\bMED-(?=\d)/g, "Med-") // капсом читает по буквам «эм-и-ди»
    .replace(/\bAAA\b/g, "triple-A")
    .replace(/\bAVG\b/g, "A-V-G");
}

function chunks(text, max = TTS_CHUNK) {
  const out = [];
  let cur = "";
  for (const p of text.split("\n")) {
    if (cur && cur.length + p.length + 1 > max) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

export async function tts(text, apiKey = process.env.ELEVENLABS_API_KEY) {
  if (!apiKey) throw new Error("не задан ELEVENLABS_API_KEY");
  const parts = [];
  for (const piece of chunks(text)) {
    const res = await fetch(`${elevenBase()}/v1/text-to-speech/${VOICE.id}?output_format=mp3_44100_192`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text: piece, model_id: VOICE.model, voice_settings: VOICE.settings }),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    parts.push(Buffer.from(await res.arrayBuffer()));
  }
  return Buffer.concat(parts);
}

export function fmtDur(sec) {
  const s = Math.round(sec || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function buildCaption(title, takes, joke = "") {
  const [a, b] = takes.map((t) => t.duration || 0);
  // дольше — значит спокойнее; разница меньше 3 с — характер не подписываем
  const mood = Math.abs(a - b) >= 3 ? (a > b ? [" спокойнее", " чуть бодрее"] : [" чуть бодрее", " спокойнее"]) : ["", ""];
  const lines = [
    `Привет! Озвучка ${title ? title + " " : ""}готова, как обычно два варианта голосом ${VOICE.name}:`,
    `v1${mood[0]}, ${fmtDur(a)}`,
    `v2${mood[1]}, ${fmtDur(b)}`,
  ];
  if (joke) lines.push(joke);
  return `${lines.join("\n")}\n\n${SIGNATURE}`;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s, n) => (s.length > n ? s.slice(0, n).trimEnd() + "…" : s);
const fileName = (title, v) => `${(title || "Озвучка").replace(/[\\/:*?"<>|]+/g, " ").trim()}_${VOICE.name}_${v}.mp3`;

export function registerVoiceover(bot, { getOwnerId, dir, selectVoiceText, captionJoke, recordOutgoing }) {
  const JOBS_FILE = join(dir, "voiceover_jobs.json");
  const jobs = existsSync(JOBS_FILE) ? JSON.parse(readFileSync(JOBS_FILE, "utf8")) : {};
  const save = () => {
    const keep = Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
    writeFileSync(JOBS_FILE, JSON.stringify(Object.fromEntries(keep.map((j) => [j.id, j])), null, 1));
  };
  const toOwner = (text, extra = {}) =>
    bot.api.sendMessage(getOwnerId(), text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
  const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });

  // Новое сообщение от Зиры. Возвращает true, если это задание на озвучку.
  async function onIncoming(msg, connId) {
    const text = msg.text || msg.caption || "";
    const docId = docIdFrom(text);
    const longText = !docId && text.length >= 300 ? text : null;
    if (!docId && !longText) return false;

    const who = esc(msg.from?.first_name || "Зира");
    let source;
    try {
      source = docId ? await fetchDocText(docId) : longText;
    } catch (e) {
      await toOwner(
        `📨 ${who} прислала док на озвучку, но открыть его не вышло (${esc(e.message)}).\n` +
          `Попроси открыть доступ по ссылке или перешли мне текст.`
      );
      return true;
    }
    const paras = paragraphs(source);
    if (!paras.length) {
      await toOwner(`📨 ${who} прислала док на озвучку, но он пустой.`);
      return true;
    }
    const pick = await pickVoiceText(paras, selectVoiceText);
    const id = Math.random().toString(36).slice(2, 8);
    const job = {
      id,
      createdAt: Date.now(),
      chatId: msg.chat.id,
      connId,
      who: msg.from?.first_name || "Зира",
      title: pick.title,
      language: pick.language,
      text: pick.text,
      excluded: pick.excluded.map((i) => paras[i]),
      status: "asked",
      takes: [],
    };
    jobs[id] = job;
    save();

    const mins = Math.max(1, Math.round(job.text.length / 1000));
    const skipped = job.excluded.length ? `\nНе озвучиваю: ${job.excluded.map((p) => `«${esc(clip(p, 60))}»`).join(", ")}` : "";
    await toOwner(
      `📨 <b>${esc(job.who)} прислала текст на озвучку</b>${job.title ? ` — «${esc(job.title)}»` : ""}\n` +
        `Язык: ${esc(job.language)}, ${job.text.length} знаков, это примерно ${mins} мин.${skipped}\n\n` +
        `<i>${esc(clip(job.text, 350))}</i>\n\n` +
        `Делаю как обычно: ${VOICE.name}, два варианта, сначала тебе послушать.`,
      kb([[{ text: "🎙 Озвучить", callback_data: `vo:go:${id}` }, { text: "Не надо", callback_data: `vo:no:${id}` }]])
    );
    return true;
  }

  async function generate(job) {
    const spoken = pronounce(job.text, job.language);
    job.takes = [];
    for (const v of ["v1", "v2"]) {
      const mp3 = await tts(spoken);
      const sent = await bot.api.sendAudio(getOwnerId(), new InputFile(mp3, fileName(job.title, v)), {
        title: `${job.title || "Озвучка"} ${v}`,
        performer: VOICE.name,
      });
      job.takes.push({ fileId: sent.audio.file_id, duration: sent.audio.duration });
    }
    let joke = "";
    if (captionJoke) {
      try {
        joke = (await captionJoke({ title: job.title, text: job.text })).trim().split("\n")[0].slice(0, 200);
      } catch (e) {
        console.error("Шутка для подписи не придумалась:", e.message);
      }
    }
    job.caption = buildCaption(job.title, job.takes, joke);
    job.status = "ready";
    save();
    await toOwner(
      `Послушай оба варианта выше. Если ок, уйдут ${esc(job.who)} одним сообщением с такой подписью:\n\n${esc(job.caption)}`,
      kb([
        [{ text: "✅ Отправить", callback_data: `vo:send:${job.id}` }],
        [
          { text: "🔁 Переделать", callback_data: `vo:redo:${job.id}` },
          { text: "✖️ Не отправлять", callback_data: `vo:drop:${job.id}` },
        ],
      ])
    );
  }

  async function send(job) {
    const media = job.takes.map((t, i) => ({
      type: "audio",
      media: t.fileId,
      ...(i === job.takes.length - 1 ? { caption: job.caption } : {}),
    }));
    await bot.api.sendMediaGroup(job.chatId, media, { business_connection_id: job.connId });
    job.status = "sent";
    job.sentAt = Date.now();
    save();
    recordOutgoing?.(job.chatId, "[озвучка, 2 варианта]");
  }

  bot.callbackQuery(/^vo:(go|no|send|redo|drop):(\w+)$/, async (ctx) => {
    if (ctx.from?.id !== getOwnerId()) return ctx.answerCallbackQuery();
    const [, action, id] = ctx.match;
    const job = jobs[id];
    if (!job) return ctx.answerCallbackQuery({ text: "Эта заявка уже не найдена" });
    const done = (note) => ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {}).then(() => note && ctx.reply(note));

    if (action === "no" || action === "drop") {
      job.status = "cancelled";
      save();
      await ctx.answerCallbackQuery({ text: "Ок, не делаю" });
      return done(action === "drop" ? `Не отправляю, файлы остались у тебя выше.` : "");
    }
    if (action === "go" || action === "redo") {
      if (job.status === "working") return ctx.answerCallbackQuery({ text: "Уже озвучиваю" });
      job.status = "working";
      save();
      await ctx.answerCallbackQuery({ text: "Озвучиваю" });
      await done(`🎙 Озвучиваю ${action === "redo" ? "заново " : ""}два варианта, это минута-две.`);
      // в фоне: grammy разбирает обновления по очереди, и бот иначе молчал бы всё это время
      void generate(job).catch(async (e) => {
        console.error("Озвучка не получилась:", e);
        job.status = "failed";
        save();
        await toOwner(`Озвучка не получилась: ${esc(e.message)}`, kb([[{ text: "🔁 Ещё раз", callback_data: `vo:go:${id}` }]])).catch(() => {});
      });
      return;
    }
    if (action === "send") {
      if (job.status === "sent") return ctx.answerCallbackQuery({ text: "Уже отправлено" });
      if (job.status === "sending") return ctx.answerCallbackQuery({ text: "Уже отправляю" });
      if (job.status !== "ready") return ctx.answerCallbackQuery({ text: "Сначала дождись файлов" });
      job.status = "sending";
      try {
        await send(job);
        await ctx.answerCallbackQuery({ text: "Отправил" });
        await done(`✅ Отправил в чат «${job.who}».`);
      } catch (e) {
        console.error("Отправка озвучки не прошла:", e);
        job.status = "ready";
        save();
        await ctx.answerCallbackQuery({ text: "Не отправилось" });
        await toOwner(
          `Не смог отправить от твоего имени: ${esc(e.description || e.message)}.\n` +
            `Так бывает, если с её последнего сообщения прошло больше суток или у бота выключено право «Отвечать на сообщения». ` +
            `Перешли ей файлы выше сам, подпись можно скопировать из сообщения выше.`
        );
      }
    }
  });

  return { onIncoming, jobs };
}
