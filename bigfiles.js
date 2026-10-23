// bigfiles.js — файлы тяжелее лимитов Bot API через MTProto (GramJS).
//
// Bot API не отдаёт боту файлы тяжелее 20 МБ и не принимает загрузки тяжелее
// 50 МБ. Это ограничение только HTTP-шлюза: тот же бот, вошедший в Telegram
// напрямую по MTProto, качает и грузит файлы до 2 ГБ. Входим ботом по его же
// токену — без аккаунта Николая и без кодов из SMS. Нужны только api_id и
// api_hash приложения с my.telegram.org (TG_API_ID / TG_API_HASH).
//
// Сессию MTProto храним в файле рядом с ботом, чтобы не входить заново на
// каждый файл (частые входы бота Telegram придерживает FLOOD_WAIT). Файл
// теряется при редеплое — не страшно, бот просто войдёт ещё раз.

import { readFileSync, writeFileSync, existsSync, mkdtempSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const apiId = () => Number(process.env.TG_API_ID || 0);
const apiHash = () => process.env.TG_API_HASH || "";
export const MTPROTO_FILE_LIMIT = 2000 * 1024 * 1024; // потолок Telegram для ботов

export function mtprotoReady() {
  return Boolean(apiId() && apiHash());
}

const clients = new Map(); // токен бота -> Promise<TelegramClient>

async function clientFor(botToken) {
  if (!mtprotoReady()) throw new Error("для файлов тяжелее 20 МБ нужны TG_API_ID и TG_API_HASH");
  if (!clients.has(botToken)) {
    const pending = (async () => {
      // GramJS тяжёлый — грузим только когда реально понадобился большой файл
      const { TelegramClient } = await import("telegram");
      const { StringSession } = await import("telegram/sessions/index.js");
      const sessionFile = join(HERE, `mtproto_${botToken.split(":")[0]}.session`);
      const saved = existsSync(sessionFile) ? readFileSync(sessionFile, "utf8").trim() : "";
      const client = new TelegramClient(new StringSession(saved), apiId(), apiHash(), {
        connectionRetries: 5,
      });
      client.setLogLevel("error");
      await client.start({ botAuthToken: botToken });
      writeFileSync(sessionFile, client.session.save());
      return client;
    })();
    clients.set(botToken, pending);
    pending.catch(() => clients.delete(botToken)); // следующая попытка войдёт заново
  }
  return clients.get(botToken);
}

function tempPath(filename) {
  const dir = mkdtempSync(join(tmpdir(), "big-"));
  return join(dir, String(filename || "file").replace(/[^\w.\-]+/g, "_"));
}

// Скачать вложение из лички с ботом. Bot API message_id в личке совпадает с
// MTProto id в ящике бота, а messages.getMessages для личек не требует peer —
// так что хватает номера сообщения.
export async function downloadBig(botToken, item) {
  if (!item.msgId) throw new Error("не знаю номер сообщения с файлом");
  const client = await clientFor(botToken);
  const { Api } = await import("telegram");
  const res = await client.invoke(
    new Api.messages.GetMessages({ id: [new Api.InputMessageID({ id: item.msgId })] })
  );
  const msg = (res.messages || []).find((m) => m.id === item.msgId && m.media);
  if (!msg) throw new Error(`сообщение ${item.msgId} с файлом не нашлось`);
  const out = tempPath(item.filename);
  await client.downloadMedia(msg, { outputFile: out });
  return out;
}

// Альбом в канал от имени бота-публикатора (дайджест-бот, он админ канала).
// items — { kind, filename, path, w, h, duration }; подпись — только к первому.
export async function sendAlbumBig(botToken, channel, items, caption) {
  const client = await clientFor(botToken);
  const { Api } = await import("telegram");
  const sent = [];
  // GramJS кладёт общие атрибуты на все файлы альбома, а у видео они свои
  // (размер кадра, длительность) — поэтому собираем альбом из готовых медиа.
  const media = [];
  for (const [i, it] of items.entries()) {
    const file = await client.uploadFile({ file: await fileFor(it), workers: 4 });
    const m =
      it.kind === "video"
        ? new Api.InputMediaUploadedDocument({
            file,
            mimeType: "video/mp4",
            attributes: [
              new Api.DocumentAttributeVideo({
                duration: it.duration || 0,
                w: it.w || 0,
                h: it.h || 0,
                supportsStreaming: true,
              }),
              new Api.DocumentAttributeFilename({ fileName: it.filename }),
            ],
          })
        : new Api.InputMediaUploadedPhoto({ file });
    media.push({ media: m, message: i === 0 && caption ? caption : "" });
  }
  const peer = await client.getInputEntity(channel);
  const { generateRandomBigInt } = await import("telegram/Helpers.js");
  const updates =
    media.length === 1
      ? await client.invoke(
          new Api.messages.SendMedia({
            peer,
            media: media[0].media,
            message: media[0].message,
            randomId: generateRandomBigInt(),
          })
        )
      : await client.invoke(
          new Api.messages.SendMultiMedia({
            peer,
            multiMedia: await Promise.all(
              media.map(async (x) => {
                // загруженное надо «прописать» в Telegram, иначе альбом не примет
                const done = await client.invoke(new Api.messages.UploadMedia({ peer, media: x.media }));
                return new Api.InputSingleMedia({
                  media: toInputMedia(Api, done),
                  message: x.message,
                  randomId: generateRandomBigInt(),
                });
              })
            ),
          })
        );
  for (const u of updates.updates || []) {
    const id = u.message?.id;
    if (id) sent.push(id);
  }
  return sent.sort((a, b) => a - b);
}

async function fileFor(it) {
  const { CustomFile } = await import("telegram/client/uploads.js");
  return it.path
    ? new CustomFile(it.filename, statSync(it.path).size, it.path)
    : new CustomFile(it.filename, it.buffer.length, "", it.buffer);
}

function toInputMedia(Api, done) {
  if (done.photo) {
    return new Api.InputMediaPhoto({
      id: new Api.InputPhoto({
        id: done.photo.id,
        accessHash: done.photo.accessHash,
        fileReference: done.photo.fileReference,
      }),
    });
  }
  return new Api.InputMediaDocument({
    id: new Api.InputDocument({
      id: done.document.id,
      accessHash: done.document.accessHash,
      fileReference: done.document.fileReference,
    }),
  });
}
