// Офлайн-тест кросспостинга: поднимает заглушку вместо VK и MAX и прогоняет
// весь путь — пересылка → «принял» → «+» → публикация. Реальные площадки не
// трогает. Запуск: node --test test/  (или node test/crosspost.test.js)

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNER = 509801940;
const CHANNEL = "neurokean_ch";

// --- заглушка VK и MAX ---
const calls = [];
let vkPhotoUploadBehaviour = "ok"; // ok | empty-then-ok | always-empty

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");
  const url = new URL(req.url, "http://localhost");
  calls.push({ path: url.pathname, body });
  const json = (o) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(o));
  };
  const base = `http://localhost:${server.address().port}`;

  switch (url.pathname) {
    case "/vk/photos.getWallUploadServer":
      return json({ response: { upload_url: `${base}/vkupload` } });
    case "/vkupload": {
      const tries = calls.filter((c) => c.path === "/vkupload").length;
      const empty =
        vkPhotoUploadBehaviour === "always-empty" ||
        (vkPhotoUploadBehaviour === "empty-then-ok" && tries === 1);
      return json(empty ? { photo: "[]", server: 1, hash: "h" } : { photo: "[{}]", server: 1, hash: "h" });
    }
    case "/vk/photos.saveWallPhoto":
      return json({ response: [{ owner_id: -228959585, id: 457239017 }] });
    case "/vk/wall.post":
      return json({ response: { post_id: 999 } });
    case "/max/uploads":
      return json({ url: `${base}/maxupload`, token: "tok" });
    case "/maxupload":
      return json({ photos: { p1: { token: "phototok" } } });
    case "/max/messages":
      return json({ message: { body: { mid: "mid.test123" } } });
    case "/tg/bottg-channel-token/sendMessage":
      return json({ ok: true, result: { message_id: 4242 } });
    case "/tg/bottg-channel-token/sendMediaGroup":
      lastTgMediaGroup = body; // тело уже прочитано выше
      return json({ ok: true, result: [{ message_id: 4242 }, { message_id: 4243 }] });
    default:
      res.statusCode = 404;
      return json({ error: "no route " + url.pathname });
  }
});

await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

process.env.VK_API_BASE = `${base}/vk`;
process.env.MAX_API_BASE = `${base}/max`;
process.env.VK_GROUP_ID = "228959585";
process.env.VK_USER_TOKEN = "vk-test-token";
process.env.MAX_BOT_TOKEN = "max-test-token";
process.env.MAX_CHAT_ID = "-71962541614558";
process.env.CROSSPOST_CHANNEL = "@" + CHANNEL;
process.env.TG_API_BASE = `${base}/tg`;
process.env.TG_CHANNEL_BOT_TOKEN = "tg-channel-token";

const { registerCrosspost } = await import("../crosspost-inbox.js");
const { postVk, collectMedia, postTelegramChannel } = await import("../crosspost.js");

// --- заглушка grammy ---
const commands = {};
const messageHandlers = [];
const fakeBot = {
  command: (name, fn) => (commands[name] = fn),
  on: (filter, fn) => filter === "message" && messageHandlers.push(fn),
};

let lastTgMediaGroup = "";
const rewrites = [];
registerCrosspost(fakeBot, {
  botToken: "tg-test-token",
  isOwner: (ctx) => ctx.from?.id === OWNER,
  dir: mkdtempSync(join(tmpdir(), "cp-")),
  onRewrite: async (text) => {
    rewrites.push(text);
    return "ПЕРЕПИСАННЫЙ ВАРИАНТ поста";
  },
});

let nextCalls = 0;
function ctxFor(message, from = OWNER) {
  const replies = [];
  return {
    chat: { type: "private", id: OWNER },
    from: { id: from },
    message,
    replies,
    reply: async (t) => (replies.push(t), {}),
  };
}
const feed = async (ctx) => messageHandlers[0](ctx, async () => void nextCalls++);
const forwarded = (over) => ({
  message_id: 1,
  date: Math.floor(Date.now() / 1000),
  forward_origin: { type: "channel", chat: { id: -1001789234008, username: CHANNEL }, message_id: 1539 },
  ...over,
});
const waitFor = async (ctx, needle, ms = 3000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (ctx.replies.some((r) => r.includes(needle))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

test("пересылка из канала становится заявкой и ждёт подтверждения", async () => {
  const ctx = ctxFor(forwarded({ text: "Стаханов и нейросети" }));
  await feed(ctx);
  assert.match(ctx.replies.join("\n"), /Принял на дубль/);
  assert.match(ctx.replies.join("\n"), /подтверди плюсом/);
  assert.equal(nextCalls, 0, "пересылка из канала не должна доходить до Клода");
});

test("плюс публикует в VK и MAX и напоминает про мессенджер", async () => {
  const ctx = ctxFor({ message_id: 2, text: "+" });
  await feed(ctx);
  assert.ok(await waitFor(ctx, "VK: https://vk.com/wall-228959585_999"), ctx.replies.join(" | "));
  assert.ok(await waitFor(ctx, "mid.test123"), ctx.replies.join(" | "));
  assert.match(ctx.replies.join("\n"), /VK-Мессенджера/);
});

test("повторная пересылка того же поста не создаёт вторую заявку", async () => {
  const ctx = ctxFor(forwarded({ text: "Стаханов и нейросети" }));
  await feed(ctx);
  assert.match(ctx.replies.join("\n"), /уже был/);
});

test("чужая пересылка и обычный текст уходят к Клоду", async () => {
  nextCalls = 0;
  const alien = ctxFor({
    message_id: 3,
    text: "смотри что пишут",
    forward_origin: { type: "channel", chat: { id: -100777, username: "someoneelse" }, message_id: 5 },
  });
  await feed(alien);
  const chat = ctxFor({ message_id: 4, text: "как дела?" });
  await feed(chat);
  assert.equal(nextCalls, 2);
  assert.equal(alien.replies.length + chat.replies.length, 0);
});

test("длинная пересылка из чужого канала уходит в рерайт, а не в дубль", async () => {
  nextCalls = 0;
  const long = "Ц".repeat(300);
  const ctx = ctxFor({
    message_id: 20,
    text: long,
    forward_origin: { type: "channel", chat: { id: -100777, username: "someoneelse" }, message_id: 7 },
  });
  await feed(ctx);
  assert.equal(nextCalls, 0, "рерайт не должен доходить до обычного разговора");
  assert.equal(rewrites.at(-1), long);
  assert.match(ctx.replies.join("\n"), /ПЕРЕПИСАННЫЙ ВАРИАНТ/);
  // и рерайт, в отличие от дубля, идёт в том числе в сам Telegram-канал
  assert.match(ctx.replies.join("\n"), /Telegram, VK, MAX/);
});

test("плюс после рерайта публикует и в Telegram-канал", async () => {
  const ctx = ctxFor({ message_id: 21, text: "+" });
  await feed(ctx);
  assert.ok(await waitFor(ctx, "Telegram: https://t.me/neurokean_ch/4242"), ctx.replies.join(" | "));
  assert.ok(await waitFor(ctx, "VK: https://vk.com/wall-228959585_999"), ctx.replies.join(" | "));
});

test("«ок» без ждущей заявки — это разговор, а не публикация", async () => {
  nextCalls = 0;
  const ctx = ctxFor({ message_id: 5, text: "ок" });
  await feed(ctx);
  assert.equal(nextCalls, 1);
  assert.equal(ctx.replies.length, 0);
});

test("альбом из двух фото собирается в одну заявку", async () => {
  const photo = (n) => [{ file_id: `small${n}`, file_size: 1000 }, { file_id: `big${n}`, file_size: 90000 }];
  const a = ctxFor(forwarded({ message_id: 10, media_group_id: "77", caption: "Альбом", photo: photo(1), forward_origin: { type: "channel", chat: { id: -1001789234008, username: CHANNEL }, message_id: 1600 } }));
  const b = ctxFor(forwarded({ message_id: 11, media_group_id: "77", photo: photo(2), forward_origin: { type: "channel", chat: { id: -1001789234008, username: CHANNEL }, message_id: 1601 } }));
  await feed(a);
  await feed(b);
  // ответ на альбом приходит в тот же чат, но по последнему сообщению группы
  assert.ok(await waitFor(b, "2 фото"), b.replies.join(" | "));
  assert.match(b.replies.join("\n"), /текст 6 симв/);
  // прибираем за собой, чтобы заявка не висела подтверждённой
  const cancel = ctxFor({ message_id: 12, text: "-" });
  await feed(cancel);
  assert.match(cancel.replies.join("\n"), /Отменил/);
});

test("пустое photo от сервера загрузки VK лечится повтором", async () => {
  vkPhotoUploadBehaviour = "empty-then-ok";
  const cfg = (await import("../crosspost.js")).loadCrosspostConfig();
  const r = await postVk(cfg, "текст", [{ kind: "photo", filename: "p.jpg", buffer: Buffer.from("x") }]);
  assert.equal(r.warnings.length, 0);
  assert.match(r.url, /wall-228959585_999/);
});

test("если фото не грузится совсем — пост уходит текстом с предупреждением", async () => {
  vkPhotoUploadBehaviour = "always-empty";
  const cfg = (await import("../crosspost.js")).loadCrosspostConfig();
  const r = await postVk(cfg, "текст", [{ kind: "photo", filename: "p.jpg", buffer: Buffer.from("x") }]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /пустое photo/);
  assert.match(r.url, /wall-228959585_999/);
  vkPhotoUploadBehaviour = "ok";
});

test("вложение тяжелее 20 МБ пропускается без похода в сеть", async () => {
  const { media, warnings } = await collectMedia("tg-test-token", [
    { kind: "video", fileId: "big", fileSize: 45 * 1048576, filename: "big.mp4" },
  ]);
  assert.equal(media.length, 0);
  assert.match(warnings[0], /45\.0 МБ/);
});

test("чужой альбом: рерайт получает и текст, и все фото", async () => {
  nextCalls = 0;
  const long = "Ч".repeat(200);
  const photo = (n) => [{ file_id: `s${n}`, file_size: 1000 }, { file_id: `b${n}`, file_size: 90000 }];
  const origin = { type: "channel", chat: { id: -100888, username: "alienalbum" }, message_id: 900 };
  const a = ctxFor({ message_id: 30, media_group_id: "88", caption: long, photo: photo(1), forward_origin: origin });
  const b = ctxFor({ message_id: 31, media_group_id: "88", photo: photo(2), forward_origin: { ...origin, message_id: 901 } });
  await feed(a);
  await feed(b);
  assert.equal(nextCalls, 0, "картинки чужого альбома не должны уходить в разговор");
  // ответ уходит по последнему сообщению альбома
  assert.ok(await waitFor(b, "2 фото"), b.replies.join(" | "));
  assert.equal(rewrites.at(-1), long);
  const cancel = ctxFor({ message_id: 32, text: "-" });
  await feed(cancel);
});

test("рерайт без картинки: фото отдельным сообщением прикрепляется к заявке", async () => {
  const long = "Ш".repeat(200);
  const ctx = ctxFor({
    message_id: 40,
    text: long,
    forward_origin: { type: "channel", chat: { id: -100999, username: "nopic" }, message_id: 5 },
  });
  await feed(ctx);
  assert.match(ctx.replies.join("\n"), /Картинки в пересылке не было/);
  const pic = ctxFor({ message_id: 41, photo: [{ file_id: "s", file_size: 100 }, { file_id: "b", file_size: 5000 }] });
  await feed(pic);
  // текст заявки — уже переписанный, а не исходный
  assert.match(pic.replies.join("\n"), /Прикрепил \(текст \d+ симв\., 1 фото\)/);
  const cancel = ctxFor({ message_id: 42, text: "-" });
  await feed(cancel);
});

test("в Telegram-канал рерайт уходит с видео в одной медиагруппе с фото", async () => {
  const cfg = (await import("../crosspost.js")).loadCrosspostConfig();
  const r = await postTelegramChannel(cfg, "текст", [
    { kind: "photo", filename: "p.jpg", buffer: Buffer.from("x") },
    { kind: "video", filename: "v.mp4", buffer: Buffer.from("y") },
  ]);
  assert.equal(r.warnings.length, 0, r.warnings.join(" | "));
  assert.match(lastTgMediaGroup, /"type":"photo"/);
  assert.match(lastTgMediaGroup, /"type":"video"/);
  assert.deepEqual(r.ids, [4242, 4243]);
});

test.after(() => server.close());
