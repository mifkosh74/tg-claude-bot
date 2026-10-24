// Telegram Business: Николай подключил бота к своему аккаунту (Настройки →
// Telegram для бизнеса → Чат-боты), и бот видит его личные переписки.
// Что бот с этим делает:
// - ведёт журнал личек и по расписанию присылает Николаю сводку «кто ждёт ответа»;
// - сообщения Зиры с текстом на озвучку отдаёт в voiceover.js.
// Сам в лички НИКОМУ не пишет: единственная отправка от имени Николая — озвучка
// Зире, и только по его кнопке.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const HOUR = 3600_000;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s, n) => (s.length > n ? s.slice(0, n).trimEnd() + "…" : s);

export function ago(ms) {
  const h = Math.floor(ms / HOUR);
  if (h >= 24) return `${Math.floor(h / 24)} дн`;
  if (h >= 1) return `${h} ч`;
  return `${Math.max(1, Math.round(ms / 60_000))} мин`;
}

// Текст сообщения для журнала: у медиа без подписи — пометка, что это было
export function describe(msg) {
  const text = msg.text || msg.caption || "";
  const kind =
    (msg.voice && `голосовое ${msg.voice.duration} с`) ||
    (msg.video_note && "кружок") ||
    (msg.photo && "фото") ||
    (msg.video && "видео") ||
    (msg.audio && `аудио ${msg.audio.file_name || ""}`.trim()) ||
    (msg.document && `файл ${msg.document.file_name || ""}`.trim()) ||
    (msg.sticker && `стикер ${msg.sticker.emoji || ""}`.trim()) ||
    (msg.contact && "контакт") ||
    (msg.location && "геолокация") ||
    "";
  return [kind && `[${kind}]`, text].filter(Boolean).join(" ") || "[сообщение]";
}

export function registerBusiness(bot, { getOwnerId, dir, summarize, voiceover, ziraId, schedule = true }) {
  const FILE = join(dir, "business_state.json");
  const st = existsSync(FILE)
    ? JSON.parse(readFileSync(FILE, "utf8"))
    : { connections: {}, chats: {}, lastSlot: "", lastSummaryAt: 0 };
  const save = () => writeFileSync(FILE, JSON.stringify(st, null, 1));

  const maxAge = Number(process.env.SUMMARY_MAX_AGE_H || 72) * HOUR;
  const hours = (process.env.SUMMARY_HOURS || "10,14,19").split(",").map(Number).filter((h) => h >= 0 && h < 24);
  const tz = Number(process.env.SUMMARY_TZ_OFFSET ?? 5); // Челябинск, UTC+5

  const toOwner = (text, extra = {}) =>
    bot.api.sendMessage(getOwnerId(), text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });

  // Подключить бота к Business может любой владелец Premium — чужие подключения игнорируем.
  async function connection(id) {
    if (st.connections[id]) return st.connections[id];
    try {
      const bc = await bot.api.getBusinessConnection(id);
      return remember(bc);
    } catch (e) {
      console.error("Не смог проверить бизнес-подключение:", e.message);
      return null;
    }
  }
  function remember(bc) {
    if (bc.user?.id !== getOwnerId()) {
      console.warn(`Чужое бизнес-подключение от ${bc.user?.id} — игнорирую`);
      return null;
    }
    st.connections[bc.id] = { enabled: bc.is_enabled, canReply: !!bc.rights?.can_reply, at: Date.now() };
    save();
    return st.connections[bc.id];
  }

  function chatOf(msg) {
    const id = String(msg.chat.id);
    const c = (st.chats[id] ||= { recent: [] });
    c.name = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(" ") || c.name || "без имени";
    c.username = msg.chat.username || c.username;
    return c;
  }
  function record(c, out, t, text) {
    if (out) c.lastOut = Math.max(c.lastOut || 0, t);
    else c.lastIn = Math.max(c.lastIn || 0, t);
    c.recent.push({ out, t, text: clip(text, 500) });
    c.recent = c.recent.slice(-20);
  }
  function recordOutgoing(chatId, text) {
    const c = st.chats[String(chatId)];
    if (!c) return;
    record(c, true, Date.now(), text);
    save();
  }

  async function onMessage(msg, edited) {
    const conn = await connection(msg.business_connection_id);
    if (!conn) return;
    const out = msg.from?.id === getOwnerId();
    const c = chatOf(msg);
    if (!out && msg.from?.is_bot) c.isBot = true;
    if (edited) {
      // правка не делает чат «новым», просто обновляем текст в журнале
      const e = c.recent.findLast((r) => r.id === msg.message_id);
      if (e) e.text = clip(describe(msg), 500);
    } else {
      record(c, out, msg.date * 1000, describe(msg));
      c.recent.at(-1).id = msg.message_id;
    }
    save();
    if (!out && !edited && ziraId && msg.chat.id === ziraId && voiceover) {
      // в фоне: разбор дока Клодом не должен держать очередь обновлений
      void voiceover.onIncoming(msg, msg.business_connection_id).catch((e) => console.error("Озвучка Зиры:", e));
    }
  }

  // Кто ждёт ответа: последнее входящее новее последнего исходящего, и не старше maxAge
  function waiting(now = Date.now()) {
    return Object.entries(st.chats)
      .filter(([, c]) => !c.isBot && c.lastIn && (!c.lastOut || c.lastIn > c.lastOut) && now - c.lastIn < maxAge)
      .map(([id, c]) => ({ id, ...c }))
      .sort((a, b) => a.lastIn - b.lastIn);
  }

  async function buildSummary(now = Date.now()) {
    const list = waiting(now);
    if (!list.length) return null;
    let gists = {};
    if (summarize) {
      const input = list
        .map((c, i) => {
          const lines = c.recent.slice(-8).map((r) => `${r.out ? "Николай" : c.name}: ${r.text}`);
          return `### Чат ${i + 1}: ${c.name}, ждёт ${ago(now - c.lastIn)}\n${lines.join("\n")}`;
        })
        .join("\n\n");
      try {
        const raw = await summarize(input);
        for (const line of raw.split("\n")) {
          const m = line.match(/^\s*(\d+)[.)]\s*(.+)$/);
          if (m) gists[Number(m[1]) - 1] = m[2].trim();
        }
      } catch (e) {
        console.error("Сводка Клодом не удалась:", e.message);
      }
    }
    const rows = list.map((c, i) => {
      const last = c.recent.filter((r) => !r.out).at(-1)?.text || "";
      const gist = gists[i] || `«${clip(last, 120)}»`;
      return `• <a href="tg://user?id=${c.id}">${esc(c.name)}</a>, ${ago(now - c.lastIn)}: ${esc(gist)}`;
    });
    return `📬 <b>Ждут ответа: ${list.length}</b>\n\n${rows.join("\n")}`;
  }

  async function sendSummary(manual = false) {
    const text = await buildSummary();
    st.lastSummaryAt = Date.now();
    save();
    if (text) await toOwner(text);
    else if (manual) await toOwner("Все лички отвечены 👌");
  }

  // Порядок важен: регистрируется первым, и business-обновления дальше не идут.
  // Иначе ctx.reply в любом старом обработчике ушёл бы собеседнику от имени Николая.
  bot.use(async (ctx, next) => {
    const u = ctx.update;
    try {
      if (u.business_connection) {
        const prev = st.connections[u.business_connection.id];
        const conn = remember(u.business_connection);
        if (conn && (!prev || prev.enabled !== conn.enabled || prev.canReply !== conn.canReply)) {
          await toOwner(
            conn.enabled
              ? `🔗 Подключился к твоему аккаунту через Telegram Business. Теперь вижу лички и присылаю сводку в ${hours.join(", ")} ч.` +
                  (conn.canReply ? "" : `\n⚠️ Нет права «Отвечать на сообщения» — озвучку Зире от твоего имени отправить не смогу, включи его в настройках чат-бота.`)
              : "🔌 Отключён от твоего аккаунта, лички больше не вижу."
          );
        }
        return;
      }
      if (u.business_message) return await onMessage(u.business_message, false);
      if (u.edited_business_message) return await onMessage(u.edited_business_message, true);
      if (u.deleted_business_messages) return;
    } catch (e) {
      console.error("Ошибка в business-обработчике:", e);
      return;
    }
    return next();
  });

  bot.command("svodka", async (ctx) => {
    if (ctx.from?.id !== getOwnerId() || ctx.chat.type !== "private") return;
    await sendSummary(true);
  });

  bot.command("lichki", async (ctx) => {
    if (ctx.from?.id !== getOwnerId() || ctx.chat.type !== "private") return;
    const conns = Object.values(st.connections);
    const on = conns.find((c) => c.enabled);
    await ctx.reply(
      (on
        ? `Подключён к твоему аккаунту. Отвечать от твоего имени: ${on.canReply ? "можно" : "нет права"}.`
        : "Не подключён: Настройки → Telegram для бизнеса → Чат-боты → @" + (bot.botInfo?.username || "MakedHeadBot") + ".") +
        `\nВ журнале чатов: ${Object.keys(st.chats).length}, ждут ответа: ${waiting().length}.` +
        `\nСводка в ${hours.join(", ")} ч (UTC${tz >= 0 ? "+" : ""}${tz}), /svodka — прямо сейчас.`
    );
  });

  if (schedule) {
    setInterval(() => {
      const local = new Date(Date.now() + tz * HOUR);
      const h = local.getUTCHours();
      const slot = `${local.toISOString().slice(0, 10)}-${h}`;
      if (!hours.includes(h) || local.getUTCMinutes() > 10 || st.lastSlot === slot) return;
      if (!Object.values(st.connections).some((c) => c.enabled)) return;
      st.lastSlot = slot;
      save();
      sendSummary().catch((e) => console.error("Сводка не ушла:", e));
    }, 60_000).unref?.();
  }

  return { waiting, buildSummary, recordOutgoing, state: st };
}
