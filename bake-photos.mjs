#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.argv[2];
const APP_PATH = path.resolve(__dirname, process.argv[3] || 'app.html');
const PHOTO_DIR = path.join(path.dirname(APP_PATH), 'photos');
const PHOTOS_PER_CAFE = 3;
const REFERER = 'https://pallysan-no3.github.io/travel-dashboard/';

if (!KEY || !KEY.startsWith('AIza')) {
  console.error('使い方: node bake-photos.mjs <API_KEY>');
  process.exit(1);
}

console.log(`▶ ${APP_PATH} を読み込み中...`);
let html;
try { html = await fs.readFile(APP_PATH, 'utf8'); }
catch (e) { console.error(`app.html を読めません: ${e.message}`); process.exit(1); }

const cafeRegex = /\{id:(\d+),name:'([^']+)',[^}]*?placeQuery:'([^']+)'/g;
const cafes = [];
let m;
while ((m = cafeRegex.exec(html)) !== null) {
  cafes.push({ id: parseInt(m[1], 10), name: m[2], placeQuery: m[3], localPhotos: [] });
}
if (cafes.length === 0) { console.error('CAFES 配列が見つかりません'); process.exit(1); }
console.log(`  ${cafes.length} 軒のカフェを検出`);

await fs.mkdir(PHOTO_DIR, { recursive: true });
console.log(`▶ photos/ ディレクトリを準備`);

let totalDl = 0, totalFail = 0, totalKB = 0;

for (const cafe of cafes) {
  process.stdout.write(`[${String(cafe.id + 1).padStart(2, ' ')}/${cafes.length}] ${cafe.name.padEnd(30, ' ').slice(0, 30)} ... `);
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
        textQuery: cafe.placeQuery,
        locationBias: { circle: { center: { latitude: 16.0544, longitude: 108.2022 }, radius: 12000 } },
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

  const photoRefs = (searchData.places?.[0]?.photos || []).slice(0, PHOTOS_PER_CAFE);
  if (photoRefs.length === 0) { console.log('⚠ 写真なし'); continue; }

  for (let i = 0; i < photoRefs.length; i++) {
    const photoName = photoRefs[i].name;
    const url = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=900&key=${KEY}`;
    try {
      const res = await fetch(url, { headers: { 'Referer': REFERER } });
      if (!res.ok) { console.log(`✗ DL失敗 (${res.status})`); totalFail++; continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const filename = `cafe-${cafe.id}-${i + 1}.jpg`;
      await fs.writeFile(path.join(PHOTO_DIR, filename), buf);
      cafe.localPhotos.push(`photos/${filename}`);
      totalDl++;
      totalKB += buf.length / 1024;
    } catch (e) { console.log(`✗ DLエラー: ${e.message}`); totalFail++; }
  }
  console.log(`✓ ${cafe.localPhotos.length}枚`);
}

console.log(`\n▶ app.html を書き換え中...`);
let updated = 0;
for (const cafe of cafes) {
  if (cafe.localPhotos.length === 0) continue;
  const newPhotosJs = `photos:[${cafe.localPhotos.map((p) => `'${p}'`).join(',')}]`;
  const pattern = new RegExp(`(\\{id:${cafe.id},[\\s\\S]*?)photos:\\[[^\\]]*\\]`);
  if (pattern.test(html)) { html = html.replace(pattern, `$1${newPhotosJs}`); updated++; }
}
console.log(`  ${updated} 軒の photos 配列を更新`);

const beforeKey = html;
html = html.replace(/^const GAPI_KEY = '[^']+';/m, "// GAPI_KEY removed: photos baked at build time");
if (html !== beforeKey) console.log('  ✓ GAPI_KEY 定数を削除');

html = html.replace(/loadAllCafePhotos\(\);/g, 'renderCafes(); // photos baked');

await fs.writeFile(APP_PATH, html, 'utf8');

console.log(`\n────────────────────────────────────`);
console.log(`✅ 完了`);
console.log(`  ダウンロード: ${totalDl} 枚 (${(totalKB / 1024).toFixed(1)} MB)`);
console.log(`  失敗:         ${totalFail} 枚`);