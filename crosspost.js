// crosspost.js — дубль постов из Telegram в VK (стена сообщества) и MAX.
//
// Порт проверенной логики из C:\Клод\ai-news-digest\crosspost.py на Node,
// чтобы она жила внутри @MakedHeadBot на bothost и работала при выключенном компе.
//
// Всё на глобальном fetch/FormData (Node 20+), внешних зависимостей нет.
//
// Что учтено кровью (см. память по проекту ai-news-digest):
//  - фото на стену VK грузятся ТОЛЬКО пользовательским токеном, групповой не умеет;
//  - photos.getWallUploadServer иногда отдаёт пустое photo (потом saveWallPhoto
//    падает с "photo is undefined") — делаем повтор, а если и он не помог, постим
//    текст без этого вложения и возвращаем предупреждение, а не роняем весь пост;
//  - у MAX для видео token приходит СРАЗУ в ответе /uploads (у фото — после
//    заливки), а ответ заливки видео — XML, не JSON;
//  - MAX нужно время на обработку видео перед отправкой сообщения;
//  - форматирование (bold/italic) никуда не переносится — везде плоский текст.

// Базы API вынесены в переменные окружения только ради офлайн-тестов
// (test/crosspost.test.js поднимает заглушку) — в бою их задавать не нужно.
const VK_API = process.env.VK_API_BASE || "https://api.vk.com/method";
const VK_V = "5.199";
const MAX_API = process.env.MAX_API_BASE || "https://botapi.max.ru";
const TG_API = process.env.TG_API_BASE || "https://api.telegram.org";
const MAX_TEXT_LIMIT = 4000;
const TG_FILE_LIMIT = 20 * 1024 * 1024; // Bot API не отдаёт файлы тяжелее 20 МБ

export function loadCrosspostConfig(env = process.env) {
  const cfg = {
    vk: {
      groupId: Number(env.VK_GROUP_ID || 0),
      userToken: env.VK_USER_TOKEN || "",
    },
    max: {
      token: env.MAX_BOT_TOKEN || "",
      chatId: env.MAX_CHAT_ID || "",
    },
    channel: {
      username: String(env.CROSSPOST_CHANNEL || "").replace(/^@/, "").toLowerCase(),
      id: env.CROSSPOST_CHANNEL_ID ? String(env.CROSSPOST_CHANNEL_ID) : "",
    },
    // Публикация в сам Telegram-канал (нужна только рерайтам: дубль там уже есть).
    // Постим не своим токеном, а токеном дайджест-бота — он уже админ канала.
    tg: {
      token: env.TG_CHANNEL_BOT_TOKEN || "",
      channel: env.CROSSPOST_CHANNEL || "",
    },
    videoWaitMs: Number(env.MAX_VIDEO_WAIT_MS || 20000),
  };
  cfg.vkReady = Boolean(cfg.vk.groupId && cfg.vk.userToken);
  cfg.maxReady = Boolean(cfg.max.token && cfg.max.chatId);
  cfg.tgReady = Boolean(cfg.tg.token && cfg.tg.channel);
  cfg.ready = cfg.vkReady || cfg.maxReady;
  return cfg;
}

export function describeConfig(cfg) {
  const miss = [];
  if (!cfg.vkReady) miss.push("VK (нужны VK_GROUP_ID + VK_USER_TOKEN)");
  if (!cfg.maxReady) miss.push("MAX (нужны MAX_BOT_TOKEN + MAX_CHAT_ID)");
  if (!cfg.tgReady) miss.push("Telegram-канал для рерайтов (нужен TG_CHANNEL_BOT_TOKEN)");
  if (!cfg.channel.username && !cfg.channel.id) miss.push("канал-источник (CROSSPOST_CHANNEL)");
  return miss;
}

// Пересылка именно из нашего канала? Сверяем и по username, и по id.
export function isSourceChannel(chatObj, cfg) {
  if (!chatObj) return false;
  const uname = String(chatObj.username || "").toLowerCase();
  const id = String(chatObj.id || "");
  return (
    (cfg.channel.username && uname === cfg.channel.username) ||
    (cfg.channel.id && id === cfg.channel.id)
  );
}

async function fetchText(url, init, label) {
  const r = await fetch(url, init);
  const text = await r.text();
  return { status: r.status, text, label };
}

async function fetchJson(url, init, label) {
  const { status, text } = await fetchText(url, init, label);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: ответ не JSON (HTTP ${status}): ${text.slice(0, 200)}`);
  }
}

// ---------- Telegram: скачивание вложений ----------

export async function tgDownload(botToken, fileId) {
  const info = await fetchJson(
    `${TG_API}/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
    undefined,
    "TG getFile"
  );
  if (!info.ok) {
    const d = info.description || JSON.stringify(info);
    throw new Error(/too big/i.test(d) ? "файл тяжелее 20 МБ, Bot API его не отдаёт" : d);
  }
  const path = info.result.file_path;
  const r = await fetch(`${TG_API}/file/bot${botToken}/${path}`);
  if (!r.ok) throw new Error(`скачивание файла: HTTP ${r.status}`);
  return { buffer: Buffer.from(await r.arrayBuffer()), path };
}

// ---------- VK ----------

async function vkCall(method, params) {
  const body = new URLSearchParams({ ...params, v: VK_V });
  const j = await fetchJson(`${VK_API}/${method}`, { method: "POST", body }, `VK ${method}`);
  if (j.error) {
    // 9 — Flood control: ВК придушил токен за частые запросы. Само отпускает,
    // но сообщение стоит написать человеческое, иначе выглядит как поломка.
    if (j.error.error_code === 9) {
      throw new Error(
        "ВК временно придушил токен за частые запросы (Flood control). " +
          "Обычно отпускает за час — просто повтори позже."
      );
    }
    throw new Error(`VK ${method}: ${j.error.error_msg}`);
  }
  return j.response;
}

async function uploadFile(url, field, item, label) {
  const fd = new FormData();
  fd.append(field, new Blob([item.buffer]), item.filename);
  const { status, text } = await fetchText(url, { method: "POST", body: fd }, label);
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text, _status: status }; // MAX на видео отвечает XML — это нормально
  }
}

async function vkUploadPhoto(cfg, item) {
  // Сервер загрузки VK регулярно отвечает пустым photo — это флап, а не ошибка
  // файла: со второй-третьей попытки проходит. Пять попыток с паузой.
  let last;
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 1500 * attempt));
    const srv = await vkCall("photos.getWallUploadServer", {
      access_token: cfg.vk.userToken,
      group_id: cfg.vk.groupId,
    });
    const up = await uploadFile(srv.upload_url, "photo", item, "VK upload");
    if (!up.photo || up.photo === "[]") {
      last = new Error(`сервер загрузки вернул пустое photo (попытка ${attempt})`);
      continue;
    }
    const saved = await vkCall("photos.saveWallPhoto", {
      access_token: cfg.vk.userToken,
      group_id: cfg.vk.groupId,
      photo: up.photo,
      server: up.server,
      hash: up.hash,
    });
    const ph = saved[0];
    return `photo${ph.owner_id}_${ph.id}`;
  }
  throw last;
}

async function vkUploadVideo(cfg, item) {
  const sv = await vkCall("video.save", {
    access_token: cfg.vk.userToken,
    group_id: cfg.vk.groupId,
    name: item.filename.replace(/\.[^.]+$/, "") || "video",
    wallpost: 0,
  });
  await uploadFile(sv.upload_url, "video_file", item, "VK video upload");
  return `video${sv.owner_id}_${sv.video_id}`;
}

export async function postVk(cfg, text, media) {
  const warnings = [];
  const attachments = [];
  for (const item of media) {
    try {
      attachments.push(
        item.kind === "video" ? await vkUploadVideo(cfg, item) : await vkUploadPhoto(cfg, item)
      );
    } catch (e) {
      warnings.push(`VK, ${item.filename}: ${e.message}`);
    }
  }
  const res = await vkCall("wall.post", {
    access_token: cfg.vk.userToken,
    owner_id: -cfg.vk.groupId,
    from_group: 1,
    message: text,
    attachments: attachments.join(","),
  });
  return {
    url: `https://vk.com/wall-${cfg.vk.groupId}_${res.post_id}`,
    postId: res.post_id,
    warnings,
  };
}

// Дозалить фото к уже опубликованному посту (лечение «текст ушёл, фото отвалилось»
// без повторной публикации — просмотры и реакции сохраняются).
export async function vkAttachPhotoToPost(cfg, postId, text, item) {
  const attachment = await vkUploadPhoto(cfg, item);
  await vkCall("wall.edit", {
    access_token: cfg.vk.userToken,
    owner_id: -cfg.vk.groupId,
    post_id: postId,
    message: text,
    attachments: attachment,
  });
  return attachment;
}

// ---------- MAX ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function postMax(cfg, text, media) {
  const auth = { Authorization: cfg.max.token };
  const warnings = [];
  const attachments = [];
  let needVideoWait = false;

  for (const item of media) {
    try {
      if (item.kind === "video") {
        // у видео token приходит сразу, до заливки файла
        const up = await fetchJson(
          `${MAX_API}/uploads?type=video`,
          { method: "POST", headers: auth },
          "MAX uploads(video)"
        );
        if (!up.url || !up.token) throw new Error(JSON.stringify(up).slice(0, 200));
        await uploadFile(up.url, "data", item, "MAX video upload");
        attachments.push({ type: "video", payload: { token: up.token } });
        needVideoWait = true;
      } else {
        const up = await fetchJson(
          `${MAX_API}/uploads?type=image`,
          { method: "POST", headers: auth },
          "MAX uploads(image)"
        );
        if (!up.url) throw new Error(JSON.stringify(up).slice(0, 200));
        const done = await uploadFile(up.url, "data", item, "MAX image upload");
        if (!done.photos) throw new Error(JSON.stringify(done).slice(0, 200));
        attachments.push({ type: "image", payload: { photos: done.photos } });
      }
    } catch (e) {
      warnings.push(`MAX, ${item.filename}: ${e.message}`);
    }
  }

  if (needVideoWait) await sleep(cfg.videoWaitMs); // MAX нужно время на обработку видео

  const r = await fetchJson(
    `${MAX_API}/messages?chat_id=${encodeURIComponent(cfg.max.chatId)}`,
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, MAX_TEXT_LIMIT), attachments }),
    },
    "MAX messages"
  );
  const mid = r?.message?.body?.mid;
  if (!mid) throw new Error(`MAX не принял сообщение: ${JSON.stringify(r).slice(0, 300)}`);
  return { mid, warnings };
}

// ---------- Telegram-канал (только для рерайтов) ----------

const TG_CAPTION_LIMIT = 1024;
const TG_TEXT_LIMIT = 4096;

async function tgCall(cfg, method, payload, isForm = false) {
  const url = `${TG_API}/bot${cfg.tg.token}/${method}`;
  const init = isForm
    ? { method: "POST", body: payload }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
  const j = await fetchJson(url, init, `TG ${method}`);
  if (!j.ok) throw new Error(`TG ${method}: ${j.description || JSON.stringify(j).slice(0, 200)}`);
  return j.result;
}

export async function postTelegramChannel(cfg, text, media) {
  const chat = cfg.tg.channel;
  // Фото и видео идут одной медиагруппой (Telegram разрешает их смешивать);
  // остальное (документы) в канал не кладём.
  const items = media.filter((m) => m.kind === "photo" || m.kind === "video");
  const warnings = [];
  const ids = [];

  if (media.length > items.length) {
    warnings.push("Telegram: в рерайт кладу только фото и видео");
  }

  // Короткий текст с вложениями — одним сообщением, подписью под ними.
  const asCaption = items.length && text.length <= TG_CAPTION_LIMIT;

  if (items.length) {
    const fd = new FormData();
    fd.append("chat_id", chat);
    const groupMedia = items.map((m, i) => ({
      type: m.kind,
      media: `attach://m${i}`,
      ...(asCaption && i === 0 ? { caption: text } : {}),
    }));
    fd.append("media", JSON.stringify(groupMedia));
    items.forEach((m, i) => fd.append(`m${i}`, new Blob([m.buffer]), m.filename));
    const sent = await tgCall(cfg, "sendMediaGroup", fd, true);
    ids.push(...sent.map((m) => m.message_id));
  }

  if (!asCaption) {
    if (text.length > TG_TEXT_LIMIT) {
      warnings.push(`Telegram: текст ${text.length} симв., обрезал до ${TG_TEXT_LIMIT}`);
    }
    const sent = await tgCall(cfg, "sendMessage", {
      chat_id: chat,
      text: text.slice(0, TG_TEXT_LIMIT),
      link_preview_options: { is_disabled: true },
    });
    ids.push(sent.message_id);
  }

  const uname = String(chat).replace(/^@/, "");
  return { url: `https://t.me/${uname}/${ids[0]}`, ids, warnings };
}

// ---------- Проверка площадок без публикации ----------

// Только чтение: подтверждает, что токены живы и что площадки пускают нас
// с того IP, где крутится бот (у VK пользовательские токены к смене страны
// относятся нервно — лучше узнать это до первой публикации).
export async function checkPlatforms(cfg) {
  const out = {};
  if (cfg.vkReady) {
    try {
      const me = await vkCall("users.get", { access_token: cfg.vk.userToken });
      const g = await vkCall("groups.getById", {
        access_token: cfg.vk.userToken,
        group_id: cfg.vk.groupId,
      });
      const group = g.groups?.[0] || g[0] || {};
      out.vk = `ок — токен от ${me[0].first_name} ${me[0].last_name}, сообщество «${group.name || cfg.vk.groupId}»`;
    } catch (e) {
      out.vk = "не отвечает: " + e.message;
    }
  }
  if (cfg.maxReady) {
    try {
      const me = await fetchJson(
        `${MAX_API}/me`,
        { headers: { Authorization: cfg.max.token } },
        "MAX me"
      );
      if (!me.user_id) throw new Error(JSON.stringify(me).slice(0, 200));
      out.max = `ок — бот ${me.name || me.username || me.user_id}`;
    } catch (e) {
      out.max = "не отвечает: " + e.message;
    }
  }
  if (cfg.tgReady) {
    try {
      const chat = await tgCall(cfg, "getChat", { chat_id: cfg.tg.channel });
      const me = await tgCall(cfg, "getMe", {});
      const admins = await tgCall(cfg, "getChatAdministrators", { chat_id: cfg.tg.channel });
      const mine = admins.find((a) => a.user.id === me.id);
      out["telegram-канал"] = mine?.can_post_messages
        ? `ок — «${chat.title}», публиковать можно`
        : `бот @${me.username} в канале «${chat.title}» без права публикации`;
    } catch (e) {
      out["telegram-канал"] = "не отвечает: " + e.message;
    }
  }
  return out;
}

// ---------- Сборка вложений заявки ----------

export async function collectMedia(botToken, items) {
  const media = [];
  const warnings = [];
  for (const it of items) {
    if (it.fileSize && it.fileSize > TG_FILE_LIMIT) {
      warnings.push(
        `${it.filename}: ${(it.fileSize / 1048576).toFixed(1)} МБ — Bot API не отдаёт файлы тяжелее 20 МБ, вложение пропущено`
      );
      continue;
    }
    try {
      const { buffer } = await tgDownload(botToken, it.fileId);
      media.push({ kind: it.kind, filename: it.filename, buffer });
    } catch (e) {
      warnings.push(`${it.filename}: ${e.message}`);
    }
  }
  return { media, warnings };
}

export { TG_FILE_LIMIT, MAX_TEXT_LIMIT };
