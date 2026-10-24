// Офлайн-тест личек через Telegram Business: журнал и сводка «кто ждёт ответа»,
// озвучка для Зиры от ссылки на Google Doc до отправки ей от имени Николая.
// Google Docs и ElevenLabs — заглушка, Telegram — фейковый бот. Запуск: npm test

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNER = 509801940;
const ZIRA = 423605705;
const CONN = "conn-owner";

const DOC = [
  "EU-med 59-89",
  "",
  "",
  "B.Well MED-59 and MED-89 – compact wrist blood pressure monitors for accurate measurements.",
  "To install the batteries, insert 2 new AAA alkaline batteries.",
  'The "AVG" symbol will be displayed.',
].join("\r\n");

// --- заглушка Google Docs и ElevenLabs ---
const ttsTexts = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/document/d/OPEN_DOC_1234567890abcdef/export") {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    return res.end("﻿" + DOC);
  }
  if (url.pathname.startsWith("/document/d/")) {
    res.setHeader("content-type", "text/html");
    return res.end("<html>Войдите в аккаунт</html>");
  }
  if (url.pathname.startsWith("/v1/text-to-speech/")) {
    assert.equal(req.headers["xi-api-key"], "el-test-key");
    ttsTexts.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).text);
    res.setHeader("content-type", "audio/mpeg");
    return res.end(Buffer.from("ID3fake-mp3"));
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
process.env.GDOCS_BASE = base;
process.env.ELEVEN_API_BASE = base;
process.env.ELEVENLABS_API_KEY = "el-test-key";

const { registerBusiness, describe: describeMsg } = await import("../business.js");
const { registerVoiceover, pronounce, pickVoiceText, paragraphs, buildCaption, docIdFrom } = await import(
  "../voiceover.js"
);

// --- фейковый grammy ---
const middlewares = [];
const commands = {};
const callbacks = [];
const api = [];
let mediaGroupFails = false;
let audioDurations = [179, 171];
const fakeBot = {
  use: (fn) => middlewares.push(fn),
  command: (name, fn) => (commands[name] = fn),
  callbackQuery: (re, fn) => callbacks.push([re, fn]),
  api: {
    sendMessage: async (chat_id, text, extra) => (api.push({ m: "sendMessage", chat_id, text, extra }), { message_id: api.length }),
    sendAudio: async (chat_id, file, extra) => {
      api.push({ m: "sendAudio", chat_id, file, extra });
      return { audio: { file_id: `file-${api.length}`, duration: audioDurations[api.filter((c) => c.m === "sendAudio").length - 1] ?? 60 } };
    },
    sendMediaGroup: async (chat_id, media, extra) => {
      if (mediaGroupFails) {
        const e = new Error("Bad Request");
        e.description = "Bad Request: BUSINESS_PEER_INVALID";
        throw e;
      }
      api.push({ m: "sendMediaGroup", chat_id, media, extra });
      return [];
    },
    getBusinessConnection: async ({ business_connection_id: id }) => ({
      id,
      user: { id: id === CONN ? OWNER : 777 },
      is_enabled: true,
      rights: { can_reply: true },
    }),
  },
};

const picks = [];
const voiceover = registerVoiceover(fakeBot, {
  getOwnerId: () => OWNER,
  dir: mkdtempSync(join(tmpdir(), "vo-")),
  selectVoiceText: async (numbered) => {
    picks.push(numbered);
    return '{"voice":[2,3,4],"title":"EU-med 59-89","language":"en"}';
  },
  captionJoke: async () => "Тонометр готов, давление у всех в норме 😄",
  recordOutgoing: (id, t) => biz.recordOutgoing(id, t),
});
let summarizeImpl = async () => "1. просит озвучку сегодня";
const biz = registerBusiness(fakeBot, {
  getOwnerId: () => OWNER,
  dir: mkdtempSync(join(tmpdir(), "biz-")),
  ziraId: ZIRA,
  voiceover,
  summarize: (s) => summarizeImpl(s),
  schedule: false,
});

let passedOn = 0;
const dispatch = async (update) => {
  for (const mw of middlewares) await mw({ update }, async () => void passedOn++);
};
const now = () => Math.floor(Date.now() / 1000);
let mid = 100;
const bmsg = (chat, from, text, over = {}) => ({
  business_message: {
    message_id: ++mid,
    business_connection_id: CONN,
    date: now(),
    chat: { id: chat.id, type: "private", first_name: chat.name },
    from: { id: from.id, first_name: from.name, is_bot: !!from.bot },
    text,
    ...over,
  },
});
const owner = { id: OWNER, name: "Николай" };
const zira = { id: ZIRA, name: "Зира" };
const ivan = { id: 1001, name: "Иван" };

const ownerTexts = () => api.filter((c) => c.m === "sendMessage" && c.chat_id === OWNER).map((c) => c.text);
const waitFor = async (cond, ms = 3000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};
const click = async (data, from = OWNER) => {
  const notes = [];
  for (const [re, fn] of callbacks) {
    const m = data.match(re);
    if (!m) continue;
    await fn({
      from: { id: from },
      match: m,
      answerCallbackQuery: async (o) => notes.push(o?.text || ""),
      editMessageReplyMarkup: async () => {},
      reply: async (t) => (notes.push(t), {}),
    });
  }
  return notes;
};
const buttons = (text) => api.find((c) => c.text === text)?.extra?.reply_markup?.inline_keyboard?.flat() || [];
const lastJobId = () => Object.values(voiceover.jobs).sort((a, b) => b.createdAt - a.createdAt)[0].id;

test("чужое бизнес-подключение игнорируется: ни сообщения Николаю, ни журнала", async () => {
  await dispatch({ business_connection: { id: "conn-stranger", user: { id: 777 }, is_enabled: true, rights: {} } });
  await dispatch({ business_message: { ...bmsg(ivan, ivan, "привет").business_message, business_connection_id: "conn-stranger" } });
  assert.equal(ownerTexts().length, 0);
  assert.equal(Object.keys(biz.state.chats).length, 0);
  assert.equal(passedOn, 0, "business-обновления не должны уходить к остальным обработчикам");
});

test("подключение без права отвечать — предупреждение Николаю", async () => {
  await dispatch({ business_connection: { id: CONN, user: { id: OWNER }, is_enabled: true, rights: {} } });
  assert.match(ownerTexts().at(-1), /Подключился/);
  assert.match(ownerTexts().at(-1), /Отвечать на сообщения/);
  await dispatch({ business_connection: { id: CONN, user: { id: OWNER }, is_enabled: true, rights: { can_reply: true } } });
  assert.doesNotMatch(ownerTexts().at(-1), /⚠️/);
});

test("входящее без ответа попадает в сводку, отвеченное — нет", async () => {
  await dispatch(bmsg(ivan, ivan, "Когда будет монтаж?"));
  assert.deepEqual(biz.waiting().map((c) => c.name), ["Иван"]);
  await dispatch(bmsg(ivan, owner, "Завтра"));
  assert.equal(biz.waiting().length, 0);
  await dispatch(bmsg({ id: 2002, name: "Спам-бот" }, { id: 2002, name: "Спам-бот", bot: true }, "Купи"));
  assert.equal(biz.waiting().length, 0, "боты в сводку не попадают");
  const old = bmsg({ id: 3003, name: "Старый" }, { id: 3003, name: "Старый" }, "ау");
  old.business_message.date = now() - 4 * 24 * 3600;
  await dispatch(old);
  assert.equal(biz.waiting().length, 0, "переписки старше трёх суток не вспоминаем");
});

test("сводка: суть от Клода, а без него — последняя реплика", async () => {
  await dispatch(bmsg({ id: 4004, name: "Петя <Админ>" }, { id: 4004, name: "Петя" }, "скинь счёт до пятницы"));
  let text = await biz.buildSummary();
  assert.match(text, /Ждут ответа: 1/);
  assert.match(text, /tg:\/\/user\?id=4004">Петя &lt;Админ&gt;</);
  assert.match(text, /просит озвучку сегодня/);
  summarizeImpl = async () => {
    throw new Error("нет связи");
  };
  text = await biz.buildSummary();
  assert.match(text, /«скинь счёт до пятницы»/);
  await commands.svodka({ from: { id: OWNER }, chat: { type: "private" } });
  assert.match(ownerTexts().at(-1), /Петя/);
  await dispatch(bmsg({ id: 4004, name: "Петя" }, owner, "ок"));
  await commands.svodka({ from: { id: OWNER }, chat: { type: "private" } });
  assert.match(ownerTexts().at(-1), /Все лички отвечены/);
});

test("Зира прислала Google Doc: Николаю вопрос с кнопкой, заголовок не озвучиваем", async () => {
  await dispatch(bmsg(zira, zira, "Приветик ) на перевод"));
  assert.equal(ownerTexts().filter((t) => /прислала/.test(t)).length, 0, "обычное сообщение — не задание");
  await dispatch(bmsg(zira, zira, "https://docs.google.com/document/d/OPEN_DOC_1234567890abcdef/edit?usp=sharing"));
  assert.ok(await waitFor(() => ownerTexts().some((t) => /прислала текст на озвучку/.test(t))));
  const ask = ownerTexts().find((t) => /прислала текст на озвучку/.test(t));
  assert.match(ask, /EU-med 59-89/);
  assert.match(ask, /Не озвучиваю: «EU-med 59-89»/);
  assert.match(picks[0], /\[1\] EU-med 59-89\n\[2\] B\.Well/);
  assert.deepEqual(buttons(ask).map((b) => b.text), ["🎙 Озвучить", "Не надо"]);
});

test("кнопку жмёт не Николай — ничего не происходит", async () => {
  await click(`vo:go:${lastJobId()}`, 777);
  assert.equal(ttsTexts.length, 0);
});

test("«Озвучить»: два прогона с правками произношения, файлы и подпись Николаю", async () => {
  await click(`vo:go:${lastJobId()}`);
  assert.ok(await waitFor(() => ownerTexts().some((t) => /Послушай оба варианта/.test(t))));
  assert.equal(ttsTexts.length, 2);
  for (const t of ttsTexts) {
    assert.doesNotMatch(t, /EU-med 59-89/);
    assert.match(t, /^Be Well Med-59 and Med-89/);
    assert.match(t, /2 new triple-A/);
    assert.match(t, /"A-V-G"/);
  }
  const audios = api.filter((c) => c.m === "sendAudio");
  assert.deepEqual(audios.map((a) => a.file.filename), ["EU-med 59-89_Liam_v1.mp3", "EU-med 59-89_Liam_v2.mp3"]);
  const ready = ownerTexts().find((t) => /Послушай оба варианта/.test(t));
  assert.match(ready, /v1 спокойнее, 2:59/);
  assert.match(ready, /v2 чуть бодрее, 2:51/);
  assert.match(ready, /Тонометр готов/);
  assert.match(ready, /Skynet_HA_hA_666, ИИ-агент Николая/);
  assert.equal(buttons(ready)[0].text, "✅ Отправить");
});

test("если отправить от имени не вышло — Николаю понятная подсказка", async () => {
  mediaGroupFails = true;
  await click(`vo:send:${lastJobId()}`);
  assert.match(ownerTexts().at(-1), /Не смог отправить от твоего имени: Bad Request: BUSINESS_PEER_INVALID/);
  assert.match(ownerTexts().at(-1), /больше суток/);
  mediaGroupFails = false;
});

test("«Отправить»: оба файла одним сообщением Зире от имени Николая, подпись под последним", async () => {
  assert.equal(biz.waiting().some((c) => c.name === "Зира"), true);
  const notes = await click(`vo:send:${lastJobId()}`);
  const sent = api.filter((c) => c.m === "sendMediaGroup");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, ZIRA);
  assert.equal(sent[0].extra.business_connection_id, CONN);
  assert.deepEqual(sent[0].media.map((m) => m.media), voiceover.jobs[lastJobId()].takes.map((t) => t.fileId));
  assert.equal(sent[0].media[0].caption, undefined);
  assert.match(sent[0].media[1].caption, /^Привет! Озвучка EU-med 59-89 готова/);
  assert.ok(notes.some((n) => /Отправил в чат «Зира»/.test(n)));
  assert.equal(biz.waiting().some((c) => c.name === "Зира"), false, "после отправки Зира больше не ждёт");
  await click(`vo:send:${lastJobId()}`);
  assert.equal(api.filter((c) => c.m === "sendMediaGroup").length, 1, "второй клик не шлёт повторно");
});

test("закрытый док — Николаю просьба открыть доступ", async () => {
  await dispatch(bmsg(zira, zira, "https://docs.google.com/document/d/CLOSED_DOC_1234567890abc/edit"));
  assert.ok(await waitFor(() => ownerTexts().some((t) => /открыть его не вышло/.test(t))));
});

test("без Клода: пометка языка и заголовок отсекаются запасным разбором", async () => {
  const paras = paragraphs("EU-med 59-89\n\nEnglish\nHello there, this is the text.\nSecond line.");
  const pick = await pickVoiceText(paras, async () => "не JSON");
  assert.equal(pick.text, "Hello there, this is the text.\nSecond line.");
  assert.equal(pick.title, "EU-med 59-89");
  assert.equal(pick.language, "en");
});

test("мелочи: произношение только для английского, подпись без характера при равной длине, id дока", () => {
  assert.equal(pronounce("B.Well MED-130", "ru"), "B.Well MED-130");
  assert.equal(pronounce("B.Well MED-130, AVG", "en"), "Be Well Med-130, A-V-G");
  const cap = buildCaption("", [{ duration: 60 }, { duration: 61 }]);
  assert.match(cap, /^Привет! Озвучка готова/);
  assert.match(cap, /\nv1, 1:00\nv2, 1:01\n\n🤖/);
  assert.equal(docIdFrom("https://docs.google.com/document/u/0/d/1R1-DepBcyg60QlP-VUKfYen6s9j_91-G9xXrZWvWmnA/edit"), "1R1-DepBcyg60QlP-VUKfYen6s9j_91-G9xXrZWvWmnA");
  assert.equal(describeMsg({ voice: { duration: 12 } }), "[голосовое 12 с]");
});

test.after(() => server.close());
