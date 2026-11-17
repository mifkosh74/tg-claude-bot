// stories.js — сторис в Telegram от имени Николая.
//
// Сторис публикует не бот, а локальный скрипт Дубля (C:\Клод\Сторис\post_story.py)
// методом Bot API postStory с токеном этого бота. Для этого нужен id бизнес-подключения
// (Telegram для бизнеса → Чат-боты → право «Управление историями»), а он приходит
// только сюда, в обновлениях бота. Модуль запоминает id подключения Николая
// и по команде /story_conn показывает его вместе с тем, есть ли право на истории.
// Сам ничего не отправляет и не публикует.

import { join } from "path";
import { dataDir, saveAtomic, loadJson } from "./storage.js";

export function registerStories(bot, { getOwnerId, dir }) {
  const FILE = join(dataDir() || dir, "stories_state.json");
  const st = loadJson(FILE, { connId: "" }, "Сторис");
  const save = () => saveAtomic(FILE, JSON.stringify(st));

  // Подключить бота к Business может любой владелец Premium: id берём только из подключений Николая
  async function check(id) {
    const bc = await bot.api.getBusinessConnection(id);
    return bc.user?.id === getOwnerId() ? bc : null;
  }

  async function remember(id, user) {
    if (!id || id === st.connId) return;
    try {
      const ok = user ? user.id === getOwnerId() : !!(await check(id));
      if (!ok) return;
      st.connId = id;
      save();
    } catch (e) {
      console.error("Сторис: не смог проверить бизнес-подключение:", e.message);
    }
  }

  // Регистрируется ДО business.js: тот business-обновления дальше не пропускает.
  // Здесь только подсматриваем id подключения и всегда отдаём обновление дальше.
  bot.use(async (ctx, next) => {
    const u = ctx.update;
    if (u.business_connection) await remember(u.business_connection.id, u.business_connection.user);
    else {
      const m = u.business_message || u.edited_business_message;
      if (m?.business_connection_id) await remember(m.business_connection_id, null);
    }
    return next();
  });

  bot.command("story_conn", async (ctx) => {
    if (ctx.from?.id !== getOwnerId() || ctx.chat.type !== "private") return;
    if (!st.connId) {
      await ctx.reply("Подключение через Telegram для бизнеса ещё не видел. Напиши кому-нибудь в личку и повтори /story_conn.");
      return;
    }
    let rights = "не проверил";
    try {
      const bc = await check(st.connId);
      rights = !bc ? "подключение не твоё" : bc.rights?.can_manage_stories ? "есть ✅" : "нет ❌ (Telegram для бизнеса → Чат-боты → право на истории)";
    } catch (e) {
      rights = `ошибка проверки: ${e.message}`;
    }
    await ctx.reply(`Подключение для сторис:\n<code>${st.connId}</code>\nПраво на истории: ${rights}`, { parse_mode: "HTML" });
  });

  return { connId: () => st.connId };
}
