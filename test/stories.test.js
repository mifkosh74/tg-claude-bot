import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNER = 509801940;
const { registerStories } = await import("../stories.js");

function setup(rights = { can_manage_stories: true }) {
  const middlewares = [];
  const commands = {};
  const calls = [];
  const bot = {
    use: (fn) => middlewares.push(fn),
    command: (name, fn) => (commands[name] = fn),
    api: {
      getBusinessConnection: async (id) => {
        calls.push(id);
        return { id, user: { id: id.startsWith("own") ? OWNER : 777 }, is_enabled: true, rights };
      },
    },
  };
  const stories = registerStories(bot, { getOwnerId: () => OWNER, dir: mkdtempSync(join(tmpdir(), "st-")) });
  const dispatch = async (update) => {
    let passed = false;
    await middlewares[0]({ update }, async () => (passed = true));
    return passed;
  };
  const replies = [];
  const runCommand = (from, type = "private") =>
    commands.story_conn({ from: { id: from }, chat: { type }, reply: async (text, extra) => replies.push({ text, extra }) });
  return { stories, dispatch, runCommand, replies, calls };
}

test("запоминает id подключения Николая и пропускает обновление дальше", async () => {
  const s = setup();
  const passed = await s.dispatch({ business_connection: { id: "own-1", user: { id: OWNER }, is_enabled: true, rights: {} } });
  assert.equal(passed, true);
  assert.equal(s.stories.connId(), "own-1");
});

test("чужое подключение не запоминает", async () => {
  const s = setup();
  await s.dispatch({ business_connection: { id: "alien-1", user: { id: 777 }, is_enabled: true, rights: {} } });
  await s.dispatch({ business_message: { business_connection_id: "alien-2", chat: { id: 1 }, text: "hi" } });
  assert.equal(s.stories.connId(), "");
});

test("id из business_message проверяется через getBusinessConnection один раз", async () => {
  const s = setup();
  for (let i = 0; i < 3; i++) await s.dispatch({ business_message: { business_connection_id: "own-2", chat: { id: 1 }, text: "x" } });
  assert.equal(s.stories.connId(), "own-2");
  assert.deepEqual(s.calls, ["own-2"]);
});

test("/story_conn показывает id и право на истории только владельцу в личке", async () => {
  const s = setup();
  await s.runCommand(OWNER);
  assert.match(s.replies[0].text, /ещё не видел/);
  await s.dispatch({ business_connection: { id: "own-3", user: { id: OWNER }, is_enabled: true, rights: {} } });
  await s.runCommand(OWNER);
  assert.match(s.replies[1].text, /own-3/);
  assert.match(s.replies[1].text, /есть ✅/);
  await s.runCommand(777);
  await s.runCommand(OWNER, "group");
  assert.equal(s.replies.length, 2);
});

test("/story_conn подсказывает, где включить право, если его нет", async () => {
  const s = setup({ can_reply: true });
  await s.dispatch({ business_connection: { id: "own-4", user: { id: OWNER }, is_enabled: true, rights: {} } });
  await s.runCommand(OWNER);
  assert.match(s.replies[0].text, /нет ❌/);
});
