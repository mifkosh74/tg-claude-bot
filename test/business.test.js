// Офлайн-тест личек через Telegram Business: журнал и сводка «кто ждёт ответа»,
// озвучка для Зиры от ссылки на Google Doc до отправки ей от имени Николая.
// Google Docs и ElevenLabs — заглушка, Telegram — фейковый бот. Запуск: npm test

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
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

// два ролика в одном доке, как 10.11.2026: инструкция к ирригатору и распаковка небулайзера
const TWO_DOC = [
  "EU-med-915",
  "",
  "",
  "The B.Well MED-915 oral irrigator is a professional device for dental and gum care.",
  "B.Well – making millions of families happier.",
  "",
  "",
  "TH-139 распаковка",
  "",
  "",
  "The compact TH-139 mesh nebulizer is easy to take with you.",
  "The TH-139 kit includes: ",
  "Accessories bag",
  "Instruction Manual",
].join("\n");

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
  if (url.pathname === "/document/d/TWO_ROLIKA_1234567890abcdef/export") {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    return res.end("﻿" + TWO_DOC);
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
const { registerVoiceover, pronounce, pickVoiceText, paragraphs, buildCaption, docIdFrom, splitSections, hundredsInWords } = await import(
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
  assert.match(ready, /Дубль, ИИ-агент Николая/);
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

test("два ролика в одном доке — два отдельных задания, у каждого свой заголовок", async () => {
  const before = ownerTexts().length;
  const nPicks = picks.length;
  await dispatch(bmsg(zira, zira, "https://docs.google.com/document/d/TWO_ROLIKA_1234567890abcdef/edit?usp=sharing"));
  assert.ok(await waitFor(() => ownerTexts().slice(before).filter((t) => /прислала текст на озвучку/.test(t)).length === 2));
  const asks = ownerTexts().slice(before).filter((t) => /прислала текст на озвучку/.test(t));
  assert.match(asks[0], /\(ролик 1 из 2\)/);
  assert.match(asks[1], /\(ролик 2 из 2\)/);
  assert.match(picks[nPicks], /^\[1\] EU-med-915\n\[2\] The B\.Well MED-915/);
  assert.match(picks[nPicks + 1], /^\[1\] TH-139 распаковка\n\[2\] The compact TH-139/);
  assert.doesNotMatch(picks[nPicks], /TH-139/, "распаковка не попадает в инструкцию");
});

test("разбиение дока: заголовок с номером между пустыми строками, иначе один ролик", () => {
  assert.equal(splitSections(TWO_DOC).length, 2);
  assert.equal(splitSections(DOC.replace(/\r\n/g, "\n")).length, 1, "один заголовок в начале — один ролик");
  assert.equal(splitSections("The kit includes:\n\nStorage case\n\nUser manual").length, 1, "пункты списка без номеров — не заголовки");
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
  assert.equal(pronounce("B.Well MED-130, AVG", "en"), "Be Well Med one hundred thirty, A-V-G.");
  assert.equal(pronounce("The PRO-22 kit, cuff 22–42 cm or 36 cm", "en"), "The Pro-22 kit, cuff 22 to 42 centimeters or 36 centimeters.");
  assert.equal(pronounce("USB Type-C, PRO-22", "ru"), "USB Type-C, PRO-22");
  // 10–11.11.2026: «915» звучал как «nine fifty», Зира приняла «nine hundred fifteen»
  assert.equal(pronounce("The B.Well MED-915 oral irrigator.", "en"), "The Be Well Med nine hundred fifteen oral irrigator.");
  assert.equal(pronounce("The compact TH-139 mesh nebulizer.", "en"), "The compact T-H one hundred thirty-nine mesh nebulizer.");
  assert.equal(pronounce("Med-2000 and PRO-20 stay.", "en"), "Med-2000 and Pro-20 stay.");
  assert.equal(pronounce("Periodontal nozzle\n300 ml water tank\nUser manual", "en"), "Periodontal nozzle,\n300-milliliter water tank,\nUser manual.");
  assert.equal(pronounce("The kit includes: \nAccessories bag\nInstruction Manual\nPlace it in the bag.", "en"), "The kit includes: \nAccessories bag,\nInstruction Manual.\nPlace it in the bag.");
  assert.deepEqual([915, 139, 300, 110].map(hundredsInWords), ["nine hundred fifteen", "one hundred thirty-nine", "three hundred", "one hundred ten"]);
  const cap = buildCaption("", [{ duration: 60 }, { duration: 61 }]);
  assert.match(cap, /^Привет! Озвучка готова/);
  assert.match(cap, /\nv1, 1:00\nv2, 1:01\n\n🤖/);
  assert.equal(docIdFrom("https://docs.google.com/document/u/0/d/1R1-DepBcyg60QlP-VUKfYen6s9j_91-G9xXrZWvWmnA/edit"), "1R1-DepBcyg60QlP-VUKfYen6s9j_91-G9xXrZWvWmnA");
  assert.equal(describeMsg({ voice: { duration: 12 } }), "[голосовое 12 с]");
});

// --- /lichki и журнал после «Обновить из Git» ---
const freshBusiness = (dir) => {
  const cmds = {};
  const mws = [];
  const biz = registerBusiness(
    {
      use: (fn) => mws.push(fn),
      command: (name, fn) => (cmds[name] = fn),
      api: {
        sendMessage: async () => ({}),
        // как в настоящем grammY: id строкой
        getBusinessConnection: async (id) => ({ id, user: { id: OWNER }, is_enabled: true, rights: { can_reply: true } }),
      },
      botInfo: { username: "MakedHeadBot" },
    },
    { getOwnerId: () => OWNER, dir, schedule: false }
  );
  const dispatch = async (update) => {
    for (const mw of mws) await mw({ update }, async () => {});
  };
  const lichki = async () => {
    let reply = "";
    await cmds.lichki({ from: { id: OWNER }, chat: { type: "private" }, reply: async (t) => void (reply = t) });
    return reply;
  };
  return { biz, dispatch, lichki };
};

test("/lichki: пустой журнал после редеплоя — не «Не подключён», а «пока не видел»", async () => {
  const { dispatch, lichki } = freshBusiness(mkdtempSync(join(tmpdir(), "biz-")));
  const empty = await lichki();
  assert.doesNotMatch(empty, /Не подключён|Отключён/);
  assert.match(empty, /Подключение пока не видел/);
  assert.match(empty, /Чат-боты → @MakedHeadBot/);

  // первое сообщение в личку: подключение узнано через getBusinessConnection
  await dispatch(bmsg({ id: 555, name: "Лена" }, { id: 555, name: "Лена" }, "привет"));
  assert.match(await lichki(), /^Подключён к твоему аккаунту\. Отвечать от твоего имени: можно/);

  // а вот настоящее отключение остаётся отключением
  await dispatch({ business_connection: { id: CONN, user: { id: OWNER }, is_enabled: false, rights: {} } });
  assert.match(await lichki(), /^Отключён от твоего аккаунта/);
});

test("журнал личек в постоянной папке: редеплой его не стирает, битый файл не роняет бота", async (t) => {
  const volume = mkdtempSync(join(tmpdir(), "biz-volume-"));
  process.env.DATA_DIR = volume;
  t.after(() => delete process.env.DATA_DIR);

  const first = freshBusiness(mkdtempSync(join(tmpdir(), "biz-code-")));
  await first.dispatch(bmsg({ id: 556, name: "Оля" }, { id: 556, name: "Оля" }, "жду ответа"));

  // новый контейнер: папка с кодом другая и пустая, в томе всё на месте
  const second = freshBusiness(mkdtempSync(join(tmpdir(), "biz-code-")));
  const after = await second.lichki();
  assert.match(after, /^Подключён к твоему аккаунту/);
  assert.match(after, /В журнале чатов: 1, ждут ответа: 1/);
  assert.equal(second.biz.waiting()[0].name, "Оля");

  // обрыв записи: мусор вместо журнала не должен оставлять бота лежать
  const logged = [];
  t.mock.method(console, "error", (...a) => logged.push(a.join(" ")));
  // JSON.parse цитирует такое начало файла в тексте ошибки
  writeFileSync(join(volume, "business_state.json"), "секрет из лички");
  const third = freshBusiness(mkdtempSync(join(tmpdir(), "biz-code-")));
  assert.match(await third.lichki(), /Подключение пока не видел/);
  assert.doesNotMatch(logged.join("\n"), /секрет/);
});

// --- озвучка после «Обновить из Git» ---
// Каждый freshVoiceover — новый контейнер: папка с кодом пустая, постоянная папка та же.
const freshVoiceover = () => {
  const cbs = [];
  const sent = [];
  const vo = registerVoiceover(
    {
      callbackQuery: (re, fn) => cbs.push([re, fn]),
      api: {
        sendMessage: async (chat_id, text, extra) => (sent.push({ m: "sendMessage", chat_id, text, extra }), {}),
        sendAudio: async () => ({ audio: { file_id: `file-${Math.random()}`, duration: 60 } }),
        sendMediaGroup: async (chat_id, media, extra) => (sent.push({ m: "sendMediaGroup", chat_id, media, extra }), []),
      },
    },
    {
      getOwnerId: () => OWNER,
      dir: mkdtempSync(join(tmpdir(), "vo-code-")),
      selectVoiceText: async () => '{"voice":[2],"title":"Тест","language":"en"}',
    }
  );
  const press = async (data) => {
    const notes = [];
    const [re, fn] = cbs[0];
    await fn({
      from: { id: OWNER },
      match: data.match(re),
      answerCallbackQuery: async (o) => notes.push(o?.text || ""),
      editMessageReplyMarkup: async () => {},
      reply: async (t) => (notes.push(t), {}),
    });
    return notes;
  };
  return { jobs: vo.jobs, onIncoming: vo.onIncoming, sent, press };
};
const voiceVolume = (t) => {
  const volume = mkdtempSync(join(tmpdir(), "vo-volume-"));
  process.env.DATA_DIR = volume;
  t.after(() => delete process.env.DATA_DIR);
  return volume;
};

test("озвучка в постоянной папке: после обновления кнопка «Отправить» работает", async (t) => {
  voiceVolume(t);
  const first = freshVoiceover();
  await first.onIncoming(
    { chat: { id: ZIRA }, from: { first_name: "Зира" }, text: "https://docs.google.com/document/d/OPEN_DOC_1234567890abcdef/edit" },
    CONN
  );
  const id = Object.keys(first.jobs)[0];
  await first.press(`vo:go:${id}`);
  assert.ok(await waitFor(() => first.jobs[id].status === "ready"));
  const files = first.jobs[id].takes.map((take) => take.fileId);

  const second = freshVoiceover();
  assert.deepEqual(second.sent, [], "готовая озвучка не считается прерванной");
  const notes = await second.press(`vo:send:${id}`);
  const group = second.sent.find((s) => s.m === "sendMediaGroup");
  assert.equal(group.chat_id, ZIRA);
  assert.equal(group.extra.business_connection_id, CONN);
  assert.deepEqual(group.media.map((m) => m.media), files);
  assert.ok(notes.some((n) => /Отправил в чат «Зира»/.test(n)), notes.join(" | "));
});

test("обновление оборвало озвучку: не висит в «Уже озвучиваю», Николаю кнопка «Ещё раз»", async (t) => {
  const volume = voiceVolume(t);
  const job = (id, status) => ({
    id,
    createdAt: Date.now(),
    chatId: ZIRA,
    connId: CONN,
    who: "Зира",
    title: "Тест",
    language: "en",
    text: "Hello there",
    excluded: [],
    status,
    takes: [],
  });
  writeFileSync(join(volume, "voiceover_jobs.json"), JSON.stringify({ cut: job("cut", "working"), half: job("half", "sending") }));

  const vo = freshVoiceover();
  assert.equal(vo.sent.length, 1);
  assert.equal(vo.sent[0].chat_id, OWNER);
  assert.match(vo.sent[0].text, /прервало озвучку «Тест»/);
  assert.deepEqual(vo.sent[0].extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ["vo:go:cut"]);
  assert.equal(vo.jobs.half.status, "ready", "оборванную отправку можно нажать ещё раз");

  const notes = await vo.press("vo:go:cut");
  assert.ok(notes.includes("Озвучиваю"), notes.join(" | "));
  assert.ok(await waitFor(() => vo.jobs.cut.status === "ready"));

  assert.equal(freshVoiceover().sent.length, 0, "при следующем запуске предупреждение не повторяется");
});

test("битый файл заданий озвучки не роняет бота и не попадает в лог", async (t) => {
  const volume = voiceVolume(t);
  // JSON.parse цитирует такое начало файла в тексте ошибки
  writeFileSync(join(volume, "voiceover_jobs.json"), "секрет из дока");
  const logged = [];
  t.mock.method(console, "error", (...a) => logged.push(a.join(" ")));
  assert.deepEqual(freshVoiceover().jobs, {});
  assert.match(logged.join("\n"), /Задания озвучки: файл не прочитался/);
  assert.doesNotMatch(logged.join("\n"), /секрет/);
});

test.after(() => server.close());
