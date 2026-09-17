// crosspost-inbox.js — приём заявок на дубль пересылкой поста боту в личку.
//
// Николай пересылает пост из канала @MakedHeadBot в личку — это команда
// «продублируй в VK и MAX». Бот отвечает «принял», ждёт «+», публикует,
// отписывается ссылками.
//
// Почему через подтверждение: 03.09.2026 на площадки уехал не тот пост.
// Пересылка = намерение, «+» = разрешение. Снимается CROSSPOST_AUTO=1.
//
// Что бот делать НЕ умеет и не сможет: канал в VK-Мессенджере
// (vk.ru/im/channels/-235311764) закрыт для любых API — только руками через
// браузер. Поэтому после публикации бот сам напоминает про него.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import {
  loadCrosspostConfig,
  describeConfig,
  isSourceChannel,
  collectMedia,
  postVk,
  postMax,
  postTelegramChannel,
  checkPlatforms,
} from "./crosspost.js";

const CONFIRM = new Set(["+", "да", "ок", "окей", "ok", "go", "поехали", "дубль", "публикуй"]);
const CANCEL = new Set(["-", "нет", "отмена", "стоп", "cancel", "не надо"]);

const GROUP_WINDOW_MS = 2500; // сколько ждём остальные сообщения медиагруппы
const CONFIRM_WINDOW_MS = 30 * 60 * 1000; // «ок» старше получаса — это уже разговор с Клодом, а не подтверждение
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

// Пересылка короче этого просто уходит Клоду в разговор: рерайтить реплику
// из чата смысла нет, а вот пост из чужого канала — почти всегда да.
const REWRITE_MIN_LENGTH = 150;

export function registerCrosspost(bot, { botToken, isOwner, dir, onRewrite }) {
  const cfg = loadCrosspostConfig();
  const QUEUE_FILE = join(dir, "crosspost_queue.json");

  const missing = describeConfig(cfg);
  if (missing.length) {
    console.log("Кросспостинг настроен не полностью, не хватает: " + missing.join("; "));
  } else {
    console.log(`Кросспостинг готов: VK ${cfg.vk.groupId}, MAX ${cfg.max.chatId}, источник @${cfg.channel.username || cfg.channel.id}`);
  }

  const auto = process.env.CROSSPOST_AUTO === "1";

  let jobs = [];
  try {
    if (existsSync(QUEUE_FILE)) jobs = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  } catch (e) {
    console.error("Очередь дублей не прочиталась, начинаю с пустой:", e.message);
  }
  const saveJobs = () => {
    try {
      writeFileSync(QUEUE_FILE, JSON.stringify(jobs.slice(-50), null, 1));
    } catch (e) {
      console.error("Очередь дублей не сохранилась:", e.message);
    }
  };

  const pending = () =>
    jobs.filter((j) => j.status === "pending" && Date.now() - j.createdAt < JOB_TTL_MS);
  const lastDone = () => [...jobs].reverse().find((j) => j.status === "done");

  const groupBuffers = new Map(); // media_group_id -> { items, text, timer, srcId }
  let lastForward = null; // последняя пересылка ЛЮБОГО происхождения — для команды /dubl
  let lastRewriteSource = null; // текст последней чужой пересылки — для команды /esche
  let lastRewriteMedia = [];
  let rewriting = false;
  let publishing = false;

  // ---------- разбор сообщения ----------

  function mediaFromMessage(msg) {
    const out = [];
    const id = msg.message_id;
    if (msg.photo?.length) {
      const best = msg.photo[msg.photo.length - 1]; // размеры отсортированы по возрастанию
      out.push({ kind: "photo", fileId: best.file_id, fileSize: best.file_size, filename: `photo_${id}.jpg` });
    }
    if (msg.video) {
      out.push({
        kind: "video",
        fileId: msg.video.file_id,
        fileSize: msg.video.file_size,
        filename: msg.video.file_name || `video_${id}.mp4`,
      });
    }
    if (msg.animation) {
      out.push({ kind: "video", fileId: msg.animation.file_id, fileSize: msg.animation.file_size, filename: `animation_${id}.mp4` });
    }
    if (msg.document) {
      const mime = msg.document.mime_type || "";
      const kind = mime.startsWith("image/") ? "photo" : mime.startsWith("video/") ? "video" : null;
      if (kind) {
        out.push({ kind, fileId: msg.document.file_id, fileSize: msg.document.file_size, filename: msg.document.file_name || `document_${id}` });
      }
    }
    return out;
  }

  function originOf(msg) {
    const o = msg.forward_origin;
    if (o?.type === "channel") return o.chat;
    if (msg.forward_from_chat) return msg.forward_from_chat; // старый формат Bot API
    return null;
  }

  function describeJob(job) {
    const photos = job.media.filter((m) => m.kind === "photo").length;
    const videos = job.media.filter((m) => m.kind === "video").length;
    const parts = [`текст ${job.text.length} симв.`];
    if (photos) parts.push(`${photos} фото`);
    if (videos) parts.push(`${videos} видео`);
    if (!photos && !videos) parts.push("без вложений");
    return parts.join(", ");
  }

  // Дубль — пост уже вышел в Telegram-канале, туда его повторять не надо.
  // Рерайт — текст новый, он идёт на все площадки, включая сам канал.
  function platformsOf(kind) {
    const list = [];
    if (kind === "rewrite" && cfg.tgReady) list.push("telegram");
    if (cfg.vkReady) list.push("vk");
    if (cfg.maxReady) list.push("max");
    return list;
  }

  const PLATFORM_NAMES = { telegram: "Telegram", vk: "VK", max: "MAX" };

  async function enqueue(ctx, { text, media, srcId, kind = "dub" }) {
    if (!text.trim() && !media.length) {
      await ctx.reply("В пересылке нет ни текста, ни вложений — дублировать нечего.");
      return;
    }
    if (srcId && jobs.some((j) => j.srcId === srcId && j.status !== "cancelled")) {
      await ctx.reply(`Пост ${srcId} у меня уже был. Пересылай заново только если предыдущая заявка отменена.`);
      return;
    }
    const job = {
      id: Date.now(),
      createdAt: Date.now(),
      chatId: ctx.chat.id,
      srcId,
      kind,
      text,
      media,
      status: "pending",
      results: {},
    };
    jobs.push(job);
    saveJobs();

    const platforms = platformsOf(kind).map((p) => PLATFORM_NAMES[p]).join(", ");
    if (!platforms) {
      job.status = "cancelled";
      saveJobs();
      await ctx.reply("Принял бы, но площадки не настроены: " + describeConfig(cfg).join("; "));
      return;
    }
    if (auto) {
      await ctx.reply(`Принял (${describeJob(job)}). Режим без подтверждения — публикую в ${platforms}.`);
      job.status = "approved";
      saveJobs();
      void runPending(ctx);
      return;
    }
    if (kind === "rewrite") {
      const attach = media.length
        ? `Вложения: ${describeJob(job).replace(/^текст \d+ симв\.,? ?/, "")}.`
        : "Картинки в пересылке не было (если она была превью ссылки — Telegram её боту не отдаёт). Пришли фото отдельным сообщением — прикреплю.";
      await ctx.reply(
        `${attach}\nПубликую в ${platforms} по плюсу (+). Минус (-) — выкинуть, /esche — другой вариант.`
      );
      return;
    }
    await ctx.reply(
      `Принял на дубль: ${describeJob(job)}.\n` +
        `Публикую в ${platforms} — подтверди плюсом (+). Передумал — минус (-).`
    );
  }

  // Пересылка альбома приходит несколькими сообщениями с общим media_group_id —
  // копим их пару секунд и собираем в одну заявку.
  // foreign=true — альбом из чужого канала: когда соберётся, уходит в рерайт, а не в дубль.
  function bufferGroup(ctx, msg, text, media, foreign = false) {
    const key = msg.media_group_id;
    const buf = groupBuffers.get(key) || { items: [], text: "", srcId: null };
    buf.items.push(...media);
    if (text && !buf.text) buf.text = text;
    if (!buf.srcId) buf.srcId = msg.forward_origin?.message_id || msg.forward_from_message_id || null;
    clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      groupBuffers.delete(key);
      if (foreign) {
        if (onRewrite && buf.text.trim().length >= REWRITE_MIN_LENGTH) {
          doRewrite(ctx, buf.text, buf.items).catch((e) => console.error("Ошибка рерайта альбома:", e));
        }
        return;
      }
      enqueue(ctx, { text: buf.text, media: buf.items, srcId: buf.srcId }).catch((e) =>
        console.error("Ошибка постановки альбома в очередь:", e)
      );
    }, GROUP_WINDOW_MS);
    groupBuffers.set(key, buf);
  }

  // Картинка, присланная отдельно (не пересылкой), пока ждёт подтверждения рерайт —
  // это вложение к нему: превью ссылок Bot API не отдаёт, приходится докидывать руками.
  async function attachToPendingRewrite(ctx, msg) {
    const job = pending().find((j) => j.kind === "rewrite");
    if (!job) return false;
    const media = mediaFromMessage(msg);
    if (!media.length) return false;
    job.media.push(...media);
    lastRewriteMedia = job.media;
    saveJobs();
    await ctx.reply(`Прикрепил (${describeJob(job)}). Плюс (+) — публикую.`);
    return true;
  }

  // ---------- рерайт чужого поста ----------

  async function doRewrite(ctx, sourceText, media = []) {
    if (!onRewrite) return;
    if (rewriting) {
      await ctx.reply("Секунду, ещё переписываю прошлый 🙃");
      return;
    }
    rewriting = true;
    const typing = setInterval(() => ctx.replyWithChatAction?.("typing").catch(() => {}), 5000);
    try {
      await ctx.reply("Переписываю…");
      const out = (await onRewrite(sourceText)) || "";
      if (!out.trim()) throw new Error("вернулся пустой текст");

      lastRewriteSource = sourceText;
      lastRewriteMedia = media;
      // Прошлый неподтверждённый рерайт снимаем, иначе «+» опубликует оба.
      for (const j of jobs) {
        if (j.kind === "rewrite" && j.status === "pending") j.status = "cancelled";
      }

      for (let i = 0; i < out.length; i += 4000) {
        await ctx.reply(out.slice(i, i + 4000), { link_preview_options: { is_disabled: true } });
      }
      await enqueue(ctx, { text: out, media, srcId: null, kind: "rewrite" });
    } catch (e) {
      console.error("Ошибка рерайта:", e);
      await ctx.reply("Рерайт не получился: " + e.message);
    } finally {
      clearInterval(typing);
      rewriting = false;
    }
  }

  // ---------- публикация ----------

  async function runPending(ctx) {
    if (publishing) return;
    publishing = true;
    try {
      const targets = jobs.filter((j) => j.status === "approved");
      for (const job of targets) {
        await publishJob(ctx, job);
      }
    } catch (e) {
      console.error("Ошибка публикации:", e);
      await ctx.reply("Публикация упала: " + e.message).catch(() => {});
    } finally {
      publishing = false;
    }
  }

  async function publishJob(ctx, job) {
    await ctx.reply("Публикую…");
    const { media, warnings } = await collectMedia(botToken, job.media);
    const lines = [];
    const allWarnings = [...warnings];
    const plats = platformsOf(job.kind || "dub");

    // Telegram первым: канал — первоисточник, остальные площадки его повторяют.
    if (plats.includes("telegram")) {
      try {
        const r = await postTelegramChannel(cfg, job.text, media);
        job.results.telegram = r.url;
        lines.push("Telegram: " + r.url);
        allWarnings.push(...r.warnings);
      } catch (e) {
        job.results.telegram = "ERROR: " + e.message;
        lines.push("Telegram: не вышло — " + e.message);
      }
    }

    if (plats.includes("vk")) {
      try {
        const r = await postVk(cfg, job.text, media);
        job.results.vk = r.url;
        job.vkPostId = r.postId;
        lines.push("VK: " + r.url);
        allWarnings.push(...r.warnings);
      } catch (e) {
        job.results.vk = "ERROR: " + e.message;
        lines.push("VK: не вышло — " + e.message);
      }
    }
    if (plats.includes("max")) {
      try {
        const r = await postMax(cfg, job.text, media);
        job.results.max = r.mid;
        lines.push("MAX: опубликовано (" + r.mid + ")");
        allWarnings.push(...r.warnings);
      } catch (e) {
        job.results.max = "ERROR: " + e.message;
        lines.push("MAX: не вышло — " + e.message);
      }
    }

    job.status = Object.values(job.results).some((v) => String(v).startsWith("ERROR"))
      ? "error"
      : "done";
    job.finishedAt = Date.now();
    saveJobs();

    if (allWarnings.length) lines.push("", "Предупреждения:", ...allWarnings.map((w) => "• " + w));
    lines.push("", "Канал VK-Мессенджера подхватит сторож на компе Николая в течение ~10 минут (если комп включён). Текст для ручной вставки — по команде /text.");
    await ctx.reply(lines.join("\n"));
  }

  // ---------- команды ----------

  bot.command("dubl", async (ctx, next) => {
    if (ctx.chat.type !== "private" || !isOwner(ctx)) return;
    if (!lastForward) {
      await ctx.reply("Не вижу пересылки. Перешли пост и сразу напиши /dubl.");
      return;
    }
    const f = lastForward;
    lastForward = null;
    await enqueue(ctx, f);
  });

  bot.command("esche", async (ctx) => {
    if (ctx.chat.type !== "private" || !isOwner(ctx)) return;
    if (!lastRewriteSource) {
      await ctx.reply("Нечего переписывать. Перешли пост из чужого канала — сделаю рерайт.");
      return;
    }
    await doRewrite(ctx, lastRewriteSource, lastRewriteMedia);
  });

  bot.command("ochered", async (ctx) => {
    if (ctx.chat.type !== "private" || !isOwner(ctx)) return;
    if (!jobs.length) return void (await ctx.reply("Очередь пуста."));
    const rows = jobs.slice(-10).map((j) => {
      const when = new Date(j.createdAt).toLocaleString("ru-RU");
      const res = Object.entries(j.results || {}).map(([k, v]) => `${k}: ${v}`).join("; ");
      return `${when} — ${j.status} — ${describeJob(j)}${res ? "\n  " + res : ""}`;
    });
    await ctx.reply(rows.join("\n"));
  });

  bot.command("text", async (ctx) => {
    if (ctx.chat.type !== "private" || !isOwner(ctx)) return;
    const job = lastDone() || jobs[jobs.length - 1];
    if (!job) return void (await ctx.reply("Нечего отдавать — заявок ещё не было."));
    await ctx.reply("Текст последнего дубля — для канала VK-Мессенджера:");
    for (let i = 0; i < job.text.length; i += 4000) {
      await ctx.reply(job.text.slice(i, i + 4000), { link_preview_options: { is_disabled: true } });
    }
  });

  bot.command("crosspost_status", async (ctx) => {
    if (ctx.chat.type !== "private" || !isOwner(ctx)) return;
    const miss = describeConfig(cfg);
    await ctx.reply(
      [
        `VK: ${cfg.vkReady ? "готов, группа " + cfg.vk.groupId : "не настроен"}`,
        `MAX: ${cfg.maxReady ? "готов, чат " + cfg.max.chatId : "не настроен"}`,
        `Источник: ${cfg.channel.username ? "@" + cfg.channel.username : cfg.channel.id || "не задан"}`,
        `Подтверждение: ${auto ? "выключено (CROSSPOST_AUTO=1)" : "плюсом"}`,
        `В очереди ждут: ${pending().length}`,
        miss.length ? "Не хватает: " + miss.join("; ") : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  });

  // Проверка боем, но без публикации: живы ли токены с того IP, где крутится бот.
  bot.command("crosspost_check", async (ctx) => {
    if (ctx.chat.type !== "private" || !isOwner(ctx)) return;
    await ctx.reply("Проверяю площадки…");
    try {
      const r = await checkPlatforms(cfg);
      const rows = Object.entries(r).map(([k, v]) => `${k.toUpperCase()}: ${v}`);
      await ctx.reply(rows.length ? rows.join("\n") : "Проверять нечего — площадки не настроены.");
    } catch (e) {
      await ctx.reply("Проверка сорвалась: " + e.message);
    }
  });

  // ---------- основной перехват сообщений ----------

  bot.on("message", async (ctx, next) => {
    if (ctx.chat.type !== "private" || !isOwner(ctx)) return next();
    const msg = ctx.message;
    const text = msg.text || msg.caption || "";

    const chat = originOf(msg);
    if (chat || msg.forward_origin) {
      const media = mediaFromMessage(msg);
      const srcId = msg.forward_origin?.message_id || msg.forward_from_message_id || null;
      // пересылку из любого места запоминаем — вдруг попросят /dubl
      lastForward = { text, media, srcId };

      // Чужая пересылка — это заявка на рерайт, а не на дубль.
      // Короткие обрывки отдаём Клоду в обычный разговор.
      if (!isSourceChannel(chat, cfg)) {
        if (msg.media_group_id) {
          // Чужой альбом: текст и фото приходят разными сообщениями — копим всё,
          // рерайт запустится, когда соберётся.
          if (onRewrite) bufferGroup(ctx, msg, text, media, true);
          return;
        }
        if (onRewrite && text.trim().length >= REWRITE_MIN_LENGTH) {
          await doRewrite(ctx, text, media);
          return;
        }
        return next();
      }

      if (msg.media_group_id) bufferGroup(ctx, msg, text, media);
      else await enqueue(ctx, { text, media, srcId });
      return;
    }

    // фото/видео без пересылки при ожидающем рерайте — докинуть к нему
    if (!text.trim() && (await attachToPendingRewrite(ctx, msg))) return;

    // подтверждение/отмена — только пока есть свежая заявка, иначе это обычный разговор
    const word = text.trim().toLowerCase();
    const waiting = pending().filter((j) => Date.now() - j.createdAt < CONFIRM_WINDOW_MS);
    if (waiting.length && (CONFIRM.has(word) || CANCEL.has(word))) {
      if (CONFIRM.has(word)) {
        for (const j of waiting) j.status = "approved";
        saveJobs();
        await ctx.reply(`Ок, публикую (${waiting.length} шт.).`);
        void runPending(ctx);
      } else {
        for (const j of waiting) j.status = "cancelled";
        saveJobs();
        await ctx.reply("Отменил, никуда не отправляю.");
      }
      return;
    }

    return next();
  });
}
