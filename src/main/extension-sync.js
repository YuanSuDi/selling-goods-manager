// extension-sync.js
// 桌面端に同梱した FurimaCopy 拡張（app/extension）を、Chrome が読み込んで
// いる実フォルダへ起動時に同期する（v0.2.18）。
//
// 仕組み:
//   - 管理プログラムの自動更新で新しい同梱版が届く → 起動時に各ターゲット
//     フォルダへ上書きコピーする。
//   - サーバは同期が全部終わった後にだけ、その版番号を /api/ping と
//     /api/tasks の応答（extVersion）で拡張へ知らせる。拡張は「自分の版
//     より新しく、かつ手が空いている」ときだけ chrome.runtime.reload()
//     で再読み込みする（拡張側 v0.12.30）。
//   - 途中まで書けた状態の版番号は絶対に知らせない（部分コピーで再読み
//     込みさせると壊れた混在状態を読みかねないため）。
//
// ターゲット:
//   - 正規フォルダ（ユーザーデータ/extension）: 管理プログラム所有なので
//     同梱側に無いファイルは掃除する（prune）。
//   - 旧フォルダ（G:\project\..., D:\tools\...）: 存在するときだけ上書き
//     コピーする。削除はしない（.git 等が同居しているため）。
"use strict";

const fs = require("fs");
const path = require("path");

function readVersion(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
    const m = JSON.parse(raw);
    return typeof m.version === "string" ? m.version : null;
  } catch (e) {
    return null;
  }
}

// root 配下のファイル一覧（相対パス）。 .git は辿らない。
function listFiles(root) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== ".git") walk(p);
      } else if (ent.isFile()) {
        out.push(path.relative(root, p));
      }
    }
  };
  walk(root);
  return out;
}

function copyTree(src, dest) {
  const files = listFiles(src);
  // manifest.json は最後に書く（版番号だけ先に新しくなる状態を作らない）。
  files.sort((a, b) => {
    const am = path.basename(a) === "manifest.json" ? 1 : 0;
    const bm = path.basename(b) === "manifest.json" ? 1 : 0;
    return am - bm;
  });
  for (const rel of files) {
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

// dest 内の、src に無いファイルを消す（正規フォルダ専用）。
function pruneStale(src, dest) {
  const keep = new Set(
    listFiles(src).map((p) => p.split(path.sep).join("/"))
  );
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.isFile()) {
        const rel = path.relative(dest, p).split(path.sep).join("/");
        if (!keep.has(rel)) {
          try {
            fs.unlinkSync(p);
          } catch (e) {
            /* 掃除の失敗で同期全体を失敗にしない */
          }
        }
      }
    }
  };
  walk(dest);
}

// targets: [{ dir, prune?: boolean, onlyIfExists?: boolean }]
// 戻り値: { ok, version, results: [{ dir, skipped?|unchanged?|updated?|error? }] }
function syncExtensionBundle(args) {
  const bundleDir = args && args.bundleDir;
  const targets = (args && args.targets) || [];
  const version = bundleDir ? readVersion(bundleDir) : null;
  if (!version) {
    return {
      ok: false,
      version: null,
      results: [],
      error: "bundled extension manifest is missing or unreadable",
    };
  }
  const results = [];
  for (const t of targets) {
    try {
      if (t.onlyIfExists && !fs.existsSync(t.dir)) {
        results.push({ dir: t.dir, skipped: true });
        continue;
      }
      const cur = readVersion(t.dir);
      if (cur === version) {
        results.push({ dir: t.dir, version, unchanged: true });
        continue;
      }
      copyTree(bundleDir, t.dir);
      if (t.prune) pruneStale(bundleDir, t.dir);
      const after = readVersion(t.dir);
      results.push({ dir: t.dir, version: after, updated: after === version });
    } catch (e) {
      results.push({ dir: t.dir, error: String((e && e.message) || e) });
    }
  }
  const ok = results.some((r) => r.updated || r.unchanged);
  return { ok, version, results };
}

module.exports = { syncExtensionBundle, readVersion };
