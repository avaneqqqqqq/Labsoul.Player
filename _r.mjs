import fs from 'node:fs';
const H = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'labsoul', 'X-GitHub-Api-Version': '2022-11-28' };
const O = 'avaneqqqqqq', R = 'Labsoul.Player', V = '1.0.68';
const ref = await (await fetch(`https://api.github.com/repos/${O}/${R}/git/ref/heads/main`, { headers: H })).json();
console.log('тег:', (await fetch(`https://api.github.com/repos/${O}/${R}/git/refs`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: `refs/tags/v${V}`, sha: ref.object.sha }) })).status);
const body = [
  'Свой музыкальный плеер: Яндекс.Музыка, SoundCloud и Spotify в одном окне.',
  '',
  '### 1.0.68 — большой апдейт',
  '',
  '**Audio Lab** (идея из Spide): усиление баса, глубина, теплота, ширина',
  'стерео, реверберация, скорость — всё в мини-окне эквалайзера, крупными',
  'ползунками, сохраняется между запусками.',
  '',
  '**Режимы звука**: Студия, Lo-Fi, Nightcore, Slowed, Vaporwave. Один клик —',
  'трек ускоряется и звучит выше или, наоборот, замедляется с тёплым низом.',
  '',
  '**Нормализация громкости** — выравнивает тихие и громкие треки.',
  '',
  '**Discord Rich Presence**: в профиле видно, что играет — название,',
  'исполнитель, обложка и время. Если Discord закрыт, ничего не ломается.',
  '',
  '**Мини-плеер поверх окон** — кнопка справа в плеере. Окно без рамки,',
  'не забирает фокус, видно поверх игр и полноэкранных видео.',
  '',
  '**Реактивный фон**: подсветка за обложкой пульсирует под бит по',
  'реальному уровню низа из анализатора спектра.',
  '',
  'Плюс из 1.0.67: караоке-подсветка текста по слову.',
  '',
  'Установка: `labsoul-1.0.68-setup.exe` или portable-zip.',
].join('\n');
const rel = await fetch(`https://api.github.com/repos/${O}/${R}/releases`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ tag_name: `v${V}`, target_commitish: 'main', name: `labsoul ${V}`, body, draft: true }) });
const data = await rel.json();
if (!rel.ok) { console.log('release:', rel.status); process.exit(1); }
for (const name of [`labsoul-${V}-setup.exe`, 'latest.yml', `labsoul-${V}-setup.exe.blockmap`, `labsoul-${V}-portable.zip`]) {
  const buf = fs.readFileSync(`app/dist/${name}`);
  console.log(`  ${name}:`, (await fetch(`https://uploads.github.com/repos/${O}/${R}/releases/${data.id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) }, body: buf })).status);
}
const pub = await fetch(`https://api.github.com/repos/${O}/${R}/releases/${data.id}`, { method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false }) });
console.log('публикация:', pub.status);
