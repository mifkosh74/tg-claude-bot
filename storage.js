// storage.js — где хранить то, что должно пережить «Обновить из Git».
//
// На bothost обновление из Git заново собирает код в /app и стирает файлы рядом
// с ботом, а отдельный том /app/data остаётся (bothost.ru/docs/sqlite-data-lost).
// Платформа задаёт DATA_DIR=/app/data, но описана эта переменная не во всех статьях,
// поэтому проверяем и сам путь. Локально нет ни того ни другого: тогда null,
// и файлы лежат рядом с кодом, как раньше.

import { accessSync, constants, existsSync, mkdirSync, renameSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

const BOTHOST_DATA = "/app/data";

export function dataDir(env = process.env) {
  const dir = env.DATA_DIR || (existsSync(BOTHOST_DATA) ? BOTHOST_DATA : "");
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return dir;
  } catch (e) {
    console.error(`Постоянная папка ${dir} недоступна на запись (${e.code || e.message}), файлы останутся рядом с ботом`);
    return null;
  }
}

// Запись через временный файл: если процесс умрёт посреди записи, прошлый файл
// останется целым. На томе битый файл, в отличие от файла рядом с кодом, сам уже не исчезнет.
// Временный файл лежит в подпапке под тем же именем: так его закрывает то же правило
// .gitignore, и токен не попадёт в Git, даже если файл останется после сбоя.
export function saveAtomic(file, text) {
  const tmp = join(dirname(file), ".tmp", basename(file));
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}
