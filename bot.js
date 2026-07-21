import { Bot } from "grammy";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "state.json");

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.API_TOKEN; // bothost кладёт токен в API_TOKEN
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN не задан. Создай файл .env со строкой BOT_TOKEN=токен_от_BotFather");
  process.exit(1);
}

// --- состояние: владелец, разрешённые группы, сессии Claude по чатам ---
function loadState() {
  const s = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
    : { ownerId: null, allowedChats: [], sessions: {} };
  // env-переменные переживают редеплой на хостинге, state.json — нет
  if (process.env.OWNER_ID) s.ownerId = Number(process.env.OWNER_ID);
  for (const id of (process.env.ALLOWED_CHATS || "").split(",").filter(Boolean)) {
    const n = Number(id.trim());
    if (n && !s.allowedChats.includes(n)) s.allowedChats.push(n);
  }
  return s;
}
function saveState() {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
const state = loadState();

const SYSTEM_PROMPT = `Ты — Клод, ИИ-ассистент Николая (Telegram-бот в его рабочих чатах студии Maked Production).
Студия занимается видеопродакшном и ИИ-контентом.

Правила:
- Отвечай по-русски, по делу, дружелюбно, без канцелярита. Формат — обычный текст для Telegram, без markdown-заголовков и таблиц. Списки можно с дефисами.
- Ты работаешь только как собеседник: у тебя НЕТ инструментов, файлов и доступа к интернету. Не обещай "посмотреть файл" или "проверить ссылку" — вместо этого попроси вставить текст прямо в чат.
- Ты не можешь смотреть видео и картинки, присланные в чат. Если просят оценить видео — попроси описать словами или передать вопрос Николаю.
- Просьбы что-то сделать от лица Николая (написать клиенту, отправить деньги, удалить что-то) не выполняй — предлагай дождаться самого Николая.
- Отвечай компактно: это мессенджер, а не статья. Обычно хватает нескольких предложений.`;

// --- Claude через Agent SDK (использует подписку Claude Code) ---
const busy = new Set();

async function askClaude(chatId, userText) {
  const options = {
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: [],
    canUseTool: async () => ({ behavior: "deny", message: "Инструменты отключены, ответь текстом." }),
    maxTurns: 3,
    cwd: __dirname,
    settingSources: [],
  };
  const prev = state.sessions[chatId];
  if (prev) options.resume = prev;

  let text = "";
  let sessionId = null;
  try {
    for await (const msg of query({ prompt: userText, options })) {
      if (msg.type === "result") {
        sessionId = msg.session_id;
        if (msg.subtype === "success") text = msg.result;
      }
    }
  } catch (e) {
    // если старая сессия протухла — пробуем один раз с чистого листа
    if (prev) {
      delete state.sessions[chatId];
      saveState();
      delete options.resume;
      for await (const msg of query({ prompt: userText, options })) {
        if (msg.type === "result") {
          sessionId = msg.session_id;
          if (msg.subtype === "success") text = msg.result;
        }
      }
    } else {
      throw e;
    }
  }
  if (sessionId) {
    state.sessions[chatId] = sessionId;
    saveState();
  }
  return text || "Хм, у меня не получилось сформулировать ответ. Попробуй переспросить.";
}

// --- Telegram ---
const bot = new Bot(BOT_TOKEN);
let me;

function isOwner(ctx) {
  return state.ownerId && ctx.from?.id === state.ownerId;
}

bot.command("start", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  if (!state.ownerId) {
    state.ownerId = ctx.from.id;
    saveState();
    await ctx.reply(
      `Привязал тебя как владельца (id ${ctx.from.id}). Чтобы привязка пережила перезапуск хостинга, добавь в панели переменную OWNER_ID=${ctx.from.id}.\n\nТеперь пиши мне тут или добавь меня в группу и разреши её командой /allow.`
    );
    return;
  }
  if (isOwner(ctx)) await ctx.reply("Уже привязаны. Пиши.");
  else await ctx.reply("Это личный бот Николая, я отвечаю только ему и в разрешённых им группах.");
});

bot.command("allow", async (ctx) => {
  if (!isOwner(ctx)) return;
  if (!state.allowedChats.includes(ctx.chat.id)) {
    state.allowedChats.push(ctx.chat.id);
    saveState();
  }
  await ctx.reply(
    `Окей, отвечаю в этом чате, когда меня упоминают (@${me.username}) или отвечают на мои сообщения.\n(Чтобы разрешение пережило перезапуск хостинга, добавь в панели переменную ALLOWED_CHATS=${state.allowedChats.join(",")})`
  );
});

bot.command("deny", async (ctx) => {
  if (!isOwner(ctx)) return;
  state.allowedChats = state.allowedChats.filter((id) => id !== ctx.chat.id);
  saveState();
  await ctx.reply("Понял, в этом чате больше не отвечаю.");
});

bot.command("reset", async (ctx) => {
  if (!isOwner(ctx)) return;
  delete state.sessions[ctx.chat.id];
  saveState();
  await ctx.reply("Контекст этого чата очищен.");
});

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;

  let shouldReply = false;
  let cleanText = text;

  if (ctx.chat.type === "private") {
    shouldReply = isOwner(ctx);
  } else {
    if (!state.allowedChats.includes(chatId)) return;
    const mention = "@" + me.username;
    const mentioned = text.includes(mention);
    const replyToMe = ctx.message.reply_to_message?.from?.id === me.id;
    if (mentioned || replyToMe) {
      shouldReply = true;
      cleanText = text.replaceAll(mention, "").trim() || "(пустое упоминание)";
      const who = ctx.from.first_name || ctx.from.username || "кто-то";
      cleanText = `[Сообщение от ${who} из группового чата]\n${cleanText}`;
    }
  }
  if (!shouldReply) return;

  if (busy.has(chatId)) {
    await ctx.reply("Секунду, ещё думаю над прошлым сообщением 🙃", { reply_to_message_id: ctx.message.message_id });
    return;
  }
  busy.add(chatId);

  const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 5000);
  ctx.replyWithChatAction("typing").catch(() => {});

  try {
    const answer = await askClaude(chatId, cleanText);
    // Telegram ограничивает сообщение 4096 символами
    for (let i = 0; i < answer.length; i += 4000) {
      await ctx.reply(answer.slice(i, i + 4000), {
        reply_to_message_id: ctx.chat.type === "private" ? undefined : ctx.message.message_id,
      });
    }
  } catch (e) {
    console.error("Ошибка ответа:", e);
    await ctx.reply("Что-то пошло не так на моей стороне 😔 Попробуй ещё раз.");
  } finally {
    clearInterval(typing);
    busy.delete(chatId);
  }
});

bot.catch((err) => console.error("Ошибка бота:", err.error));

const run = async () => {
  me = await bot.api.getMe();
  console.log(`Запущен как @${me.username}. Владелец: ${state.ownerId ?? "не привязан (жду /start в личке)"}`);
  await bot.start();
};
run();
