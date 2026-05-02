#!/usr/bin/env node
// bake-photos.mjs — Google Places の写真を CAFES / FOODS / SOUVENIRS にローカル焼き込み
//
// 注意:
// - APIキーは Google Cloud Console で一時的に復元 → 実行 → 完了後すぐ削除
// - Places API (New) "places.searchText" + "places.photos.media" を使用
// - 既存ファイルは上書き、無効idは無視
//
// 使い方:
//   node bake-photos.mjs <API_KEY> [app.html へのパス]

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.argv[2];
const APP_PATH = path.resolve(__dirname, process.argv[3] || 'app.html');
const PHOTO_DIR = path.join(path.dirname(APP_PATH), 'photos');
const PHOTOS_PER_ITEM = 3;
const REFERER = 'https://pallysan-no3.github.io/travel-dashboard/';

if (!KEY || !KEY.startsWith('AIza')) {
  console.error('使い方: node bake-photos.mjs <API_KEY> [app.html]');
  process.exit(1);
}

console.log(`▶ ${APP_PATH} を読み込み中...`);
let html;
try { html = await fs.readFile(APP_PATH, 'utf8'); }
catch (e) { console.error(`app.html を読めません: ${e.message}`); process.exit(1); }

// ── ターゲットグループ定義 ─────────────────────────────
const targetGroups = [
  {
    name: 'CAFES',
    idPrefix: 'cafe',
    // {id:N,name:'...',....,placeQuery:'...'
    regex: /\{id:(\d+),name:'([^']+)',[^}]*?placeQuery:'([^']+)'/g,
  },
  {
    name: 'FOODS',
    idPrefix: 'food',
    // {id:N,city:'...',category:'...',name:'...',....,mapsQuery:'...'
    // 名前は ' or " どちらでも対応（Pizza 4P's のため）
    regex: /\{id:(\d+),city:'[^']+',category:'[^']+',name:(?:'([^']+)'|"([^"]+)"),[^}]*?mapsQuery:(?:'([^']+)'|"([^"]+)")/g,
  },
  {
    name: 'SOUVENIRS',
    idPrefix: 'souvenir',
    // {id:N,city:'...',name:'...',category:'...',....,mapsQuery:'...'
    regex: /\{id:(\d+),city:'[^']+',name:'([^']+)',category:'[^']+',[^}]*?mapsQuery:'([^']+)'/g,
  },
];

// 全グループをまとめて1つのフラットリストに
const allItems = [];
for (const g of targetGroups) {
  let m;
  // RegExp は state を持つので clone
  const rx = new RegExp(g.regex.source, g.regex.flags);
  while ((m = rx.exec(html)) !== null) {
    // m[2]/m[3]: name (single / double quote)
    // m[4]/m[5]: query (single / double) for FOODS
    const name  = m[2] ?? m[3];
    const query = m[4] ?? m[5] ?? m[3];
    // For CAFES regex, m[3] is placeQuery directly; for SOUVENIRS, m[3] is mapsQuery
    const finalQuery = g.idPrefix === 'cafe'     ? m[3]
                     : g.idPrefix === 'souvenir' ? m[3]
                     : query;
    allItems.push({
      group: g.name,
      idPrefix: g.idPrefix,
      id: parseInt(m[1], 10),
      name,
      query: finalQuery,
      localPhotos: [],
    });
  }
}

if (allItems.length === 0) { console.error('対象配列が見つかりません'); process.exit(1); }
console.log(`  検出: 合計 ${allItems.length} 件`);
const counts = {};
for (const it of allItems) counts[it.group] = (counts[it.group] || 0) + 1;
for (const k in counts) console.log(`    ${k}: ${counts[k]} 件`);

await fs.mkdir(PHOTO_DIR, { recursive: true });
console.log(`▶ photos/ ディレクトリを準備`);

let totalDl = 0, totalFail = 0, totalKB = 0;

for (let idx = 0; idx < allItems.length; idx++) {
  const it = allItems[idx];
  const tag = `${it.idPrefix}-${it.id}`;
  process.stdout.write(`[${String(idx + 1).padStart(3, ' ')}/${allItems.length}] ${tag.padEnd(14)} ${it.name.padEnd(30, ' ').slice(0, 30)} ... `);
  let searchData;
  try {
    const searchRes = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.photos',
        'Referer': REFERER,
      },
      body: JSON.stringify({
        textQuery: it.query,
        locationBias: { circle: { center: { latitude: 16.0544, longitude: 108.2022 }, radius: 60000 } },
        maxResultCount: 1,
      }),
    });
    if (!searchRes.ok) {
      const txt = await searchRes.text();
      console.log(`✗ 検索失敗 (${searchRes.status}) ${txt.slice(0, 80)}`);
      totalFail++;
      continue;
    }
    searchData = await searchRes.json();
  } catch (e) { console.log(`✗ 検索エラー: ${e.message}`); totalFail++; continue; }

  const photoRefs = (searchData.places?.[0]?.photos || []).slice(0, PHOTOS_PER_ITEM);
  if (photoRefs.length === 0) { console.log('⚠ 写真なし'); continue; }

  for (let i = 0; i < photoRefs.length; i++) {
    const photoName = photoRefs[i].name;
    const url = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=900&key=${KEY}`;
    try {
      const res = await fetch(url, { headers: { 'Referer': REFERER } });
      if (!res.ok) { console.log(`✗ DL失敗 (${res.status})`); totalFail++; continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const filename = `${it.idPrefix}-${it.id}-${i + 1}.jpg`;
      await fs.writeFile(path.join(PHOTO_DIR, filename), buf);
      it.localPhotos.push(`photos/${filename}`);
      totalDl++;
      totalKB += buf.length / 1024;
    } catch (e) { console.log(`✗ DLエラー: ${e.message}`); totalFail++; }
  }
  console.log(`✓ ${it.localPhotos.length}枚`);
}

console.log(`\n▶ app.html を書き換え中...`);
let updated = 0;
for (const it of allItems) {
  if (it.localPhotos.length === 0) continue;
  const newPhotosJs = `photos:[${it.localPhotos.map((p) => `'${p}'`).join(',')}]`;

  // CAFES: photos:[...] が既存（Phase1から）
  // FOODS / SOUVENIRS: photos:[] (Phase2 で追加済み)
  // どちらも 同じ id 値の最初のエントリ単位で書き換え
  // 厳密性のため: そのグループ専用に query を含めた前後マッチで限定
  // ただし id は各グループで重複あり（cafe id 0 / food id 0 / souvenir id 0 など）
  // → name を組み込んで唯一に
  // 注: name に特殊な regex メタ文字が含まれうるので escape

  const escName = it.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // パターン: その name を含む {...} ブロック内の photos:[...]
  const pattern = new RegExp(
    `(name:(?:'${escName}'|"${escName}")[\\s\\S]*?)photos:\\[[^\\]]*\\]`
  );
  if (pattern.test(html)) {
    html = html.replace(pattern, `$1${newPhotosJs}`);
    updated++;
  }
}
console.log(`  ${updated} 件の photos 配列を更新`);

await fs.writeFile(APP_PATH, html, 'utf8');

console.log(`\n────────────────────────────────────`);
console.log(`✅ 完了`);
console.log(`  ダウンロード: ${totalDl} 枚 (${(totalKB / 1024).toFixed(1)} MB)`);
console.log(`  失敗:         ${totalFail} 枚`);
console.log(`\n⚠ APIキーを Google Cloud Console から削除してください`);
