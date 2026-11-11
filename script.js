'use strict';

const $ = (id) => document.getElementById(id);
const pdfBase = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/';
const ocrBase = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/';
const state = { document: null, page: 0, readingPage: 0, line: 0, zoom: 1, url: null };
let pending;
let busy = false;
let selection;
let pdfLibrary;
let ocrLibrary;
let database;
const settings = { size: 24, color: '#416bb6' };
try { Object.assign(settings, JSON.parse(localStorage.getItem('reading-ruler-settings'))); } catch {}

function openDatabase() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('reading-ruler', 1);
    request.onupgradeneeded = () => {
      for (const name of ['documents', 'history']) request.result.createObjectStore(name, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => { database = null; throw error; });
  return database;
}

async function storage(stores, mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    const request = operation(transaction);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

function showStatus(message) { $('status').textContent = message; }
function importStatus(message) { $('import-status').textContent = message; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function fitTitle() {
  const heading = $('title');
  const title = state.document?.title || 'リーディングルーラー';
  heading.title = title;
  heading.setAttribute('aria-label', title);
  heading.textContent = title;
  if (heading.scrollWidth <= heading.clientWidth) return;
  const characters = Array.from(title);
  let low = 0;
  let high = characters.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    heading.textContent = characters.slice(0, middle).join('') + '・・・';
    if (heading.scrollWidth <= heading.clientWidth) low = middle;
    else high = middle - 1;
  }
  heading.textContent = characters.slice(0, low).join('') + '・・・';
}

const readingMeasure = document.createElement('canvas').getContext('2d');
const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' });
let readingLayout;

function getReadingLines() {
  const sentences = state.document?.pages[state.readingPage].lines;
  if (!sentences) return [];

  const current = $('current-text');
  const style = getComputedStyle(current);
  const width = Math.max(
    1,
    current.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 1
  );
  const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

  if (
    readingLayout?.sentences === sentences &&
    readingLayout.width === width &&
    readingLayout.font === font
  ) {
    return readingLayout.lines;
  }

  readingMeasure.font = font;
  const lines = [];
  const positions = [];

  for (const [sentenceIndex, sentence] of sentences.entries()) {
    const characters = Array.from(graphemes.segment(sentence), ({ segment }) => segment);
    let start = 0;

    while (start < characters.length) {
      let end = start + 1;
      let line = characters[start];
      let breakAt = start;

      while (end < characters.length) {
        const next = line + characters[end];
        if (readingMeasure.measureText(next).width > width) break;

        line = next;
        end++;
        if (/[、，,；;\s]/u.test(characters[end - 1])) breakAt = end;
      }

      // 行の後半に読点や空白があれば、そこで区切る。
      if (end < characters.length && breakAt > start + (end - start) / 2) {
        end = breakAt;
      }

      lines.push(characters.slice(start, end).join('').trim());
      positions.push({ sentenceIndex, start, end });
      start = end;

      while (start < characters.length && /^\s$/u.test(characters[start])) {
        start++;
      }
    }
  }

  // 画面幅や文字サイズが変わっても、読んでいた箇所を含む行を表示する。
  if (readingLayout?.sentences === sentences) {
    const previous = readingLayout.positions[state.line];
    if (previous) {
      const index = positions.findIndex((position) =>
        position.sentenceIndex === previous.sentenceIndex &&
        position.start <= previous.start &&
        previous.start < position.end
      );
      if (index >= 0) state.line = index;
    }
  }

  readingLayout = { sentences, width, font, lines, positions };
  return lines;
}

function renderReading() {
  const lines = getReadingLines();
  state.line = clamp(state.line, 0, Math.max(0, lines.length - 1));
  const index = state.line;

    const sourcePage =
    state.document?.pages[state.readingPage].sourcePage ??
    state.readingPage + 1;

  $('reading-page').textContent = state.document
    ? '元資料 ' + sourcePage + 'ページの文章' +
      ($('lock').checked ? '・固定中' : '')
    : '';
  $('previous-text').textContent = lines[index - 1] ?? '';
  $('current-text').textContent = lines[index] ?? (
    state.document
      ? 'このページに認識された文章はありません。'
      : '資料を読み込むと、ここに文章が表示されます。'
  );
  $('next-text').textContent = lines[index + 1] ?? '';

  $('line').value = lines.length ? index + 1 : '';
  $('line').max = lines.length;
  $('line').disabled = !lines.length;
  $('line-total').textContent = lines.length ? '/ ' + lines.length + ' 行' : '行';
  $('previous-text').disabled = $('line-prev').disabled = index === 0;
  $('next-text').disabled = $('line-next').disabled = index + 1 >= lines.length;
}

function setLine(index) {
  const count = getReadingLines().length;
  state.line = clamp(index, 0, Math.max(0, count - 1));
  renderReading();
}

function changeZoom(zoom, anchorX, anchorY) {
  if (!state.document) return;
  const viewer = $('viewer');
  const previous = state.zoom;
  state.zoom = clamp(zoom, 0.5, 5);
  $('original').style.width = state.zoom * 100 + '%';
  $('zoom-reset').textContent = Math.round(state.zoom * 100) + '%';
  if (anchorX !== undefined) {
    const ratio = state.zoom / previous;
    viewer.scrollLeft = (viewer.scrollLeft + anchorX) * ratio - anchorX;
    viewer.scrollTop = (viewer.scrollTop + anchorY) * ratio - anchorY;
  }
}

function renderPage() {
  const count = state.document?.pages.length ?? 0;
  $('page').value = count ? state.page + 1 : '';
  $('page').max = count;
  $('page').disabled = !count;
    const sourcePage =
    state.document?.pages[state.page].sourcePage ??
    state.page + 1;

  $('page-total').textContent = count
    ? '/ ' + count + ' ページ（元資料 ' + sourcePage + 'ページ）'
    : 'ページ';
  $('page-prev').disabled = state.page === 0;
  $('page-next').disabled = state.page + 1 >= count;
  for (const id of ['zoom-out', 'zoom-in', 'zoom-reset', 'tools']) $(id).disabled = !count;
  $('empty').hidden = Boolean(count);
  $('original').hidden = !count;
  if (!count) return;
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(state.document.pages[state.page].image);
  $('original').src = state.url;
  $('original').alt = '資料の ' + (state.page + 1) + ' ページ';
  $('viewer').scrollTo(0, 0);
  changeZoom(state.zoom);
}

function setPage(index) {
  if (!state.document) return;
  const page = clamp(index, 0, state.document.pages.length - 1);
  if (page !== state.page) {
    state.page = page;
    if (!$('lock').checked) {
      state.readingPage = page;
      state.line = 0;
    }
    renderPage();
  } else $('page').value = page + 1;
  renderReading();
}

function toggleTools(open) {
  $('tool-panel').hidden = !open;
  $('tools').setAttribute('aria-expanded', String(open));
  if (open) $('lock').focus();
  else if (!$('tools').disabled) $('tools').focus();
}

function displayDocument(document, memo) {
  Object.assign(state, { document, page: 0, readingPage: 0, line: 0, zoom: 1 });
  $('lock').checked = false;
  $('memo').value = memo;
  $('memo-status').textContent = '';
  $('tool-panel').hidden = true;
  $('tools').setAttribute('aria-expanded', 'false');
  fitTitle();
  renderReading();
  renderPage();
}

function applySettings() {
  document.documentElement.style.setProperty('--reading-size', settings.size + 'px');
  document.documentElement.style.setProperty('--ruler', settings.color);
  $('size').value = settings.size;
  $('size-output').value = settings.size + ' px';
  $('color').value = settings.color;
}

function saveSettings() {
  settings.size = Number($('size').value);
  settings.color = $('color').value;
  applySettings();
  try { localStorage.setItem('reading-ruler-settings', JSON.stringify(settings)); }
  catch { showStatus('このブラウザでは設定を保存できませんでした。'); }
}

async function loadPDF() {
  pdfLibrary ??= import(pdfBase + 'build/pdf.mjs').then((library) => {
    library.GlobalWorkerOptions.workerSrc = pdfBase + 'build/pdf.worker.mjs';
    return library;
  }).catch((error) => { pdfLibrary = null; throw error; });
  return pdfLibrary;
}

function loadOCR() {
  ocrLibrary ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = ocrBase + 'dist/tesseract.min.js';
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => { script.remove(); reject(new Error('OCRライブラリを取得できませんでした。')); };
    document.head.append(script);
  }).catch((error) => { ocrLibrary = null; throw error; });
  return ocrLibrary;
}

function canvas(width, height) {
  const target = document.createElement('canvas');
  target.width = Math.max(1, Math.floor(width));
  target.height = Math.max(1, Math.floor(height));
  return target;
}

async function renderOriginal(source, index) {
  if (source.pdf) {
    const page = await source.pdf.getPage(index + 1);
    try {
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, 2400 / Math.max(natural.width, natural.height)) });
      const target = canvas(viewport.width, viewport.height);
      await page.render({ canvasContext: target.getContext('2d', { alpha: false }), viewport }).promise;
      return target;
    } finally { page.cleanup(); }
  }
  const image = await createImageBitmap(source.file);
  try {
    const scale = Math.min(1, 3200 / Math.max(image.width, image.height));
    const target = canvas(image.width * scale, image.height * scale);
    const context = target.getContext('2d', { alpha: false });
    context.fillStyle = 'white';
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(image, 0, 0, target.width, target.height);
    return target;
  } finally { image.close(); }
}

function refreshImportControls() {
  $('file').disabled = busy;
  $('custom-title').disabled = busy;
  $('exclude').disabled = busy;
  $('start').disabled = busy || !pending;
  $('import-dialog').querySelector('[data-close]').disabled = busy;
  $('mask-prev').disabled = busy || !pending || pending.index === 0;
  $('mask-next').disabled = busy || !pending || pending.index + 1 >= pending.count;
  $('mask-undo').disabled = busy || !pending?.masks.get(pending.index)?.length;
  $('mask-editor').hidden = !$('exclude').checked || !pending;
}

async function prepareFile(file) {
  const previous = pending;
  pending = null;
  selection = null;
  importStatus('');
  busy = true;
  refreshImportControls();
  importStatus('ファイルを確認中…');
  let loading;
  try {
    if (previous?.pdf) await previous.pdf.destroy().catch(() => {});
    if (!file) { importStatus(''); return; }
    let pdf = null;
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      const library = await loadPDF();
      loading = library.getDocument({
        data: await file.arrayBuffer(),
        cMapUrl: pdfBase + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: pdfBase + 'standard_fonts/',
        isEvalSupported: false
      });
      pdf = await loading.promise;
    } else if (!/\.(png|jpe?g)$/i.test(file.name) && !['image/png', 'image/jpeg'].includes(file.type)) {
      throw new Error('PDF・PNG・JPEGを選択してください。');
    }
    pending = { file, pdf, count: pdf?.numPages ?? 1, index: 0, masks: new Map(), preview: null };
    importStatus(pending.count + ' ページを読み込めます。');
    if ($('exclude').checked) await drawPreview();
  } catch (error) {
    pending = null;
    if (loading) await loading.destroy().catch(() => {});
    importStatus('ファイルを開けませんでした。' + (error.message || String(error)));
  } finally { busy = false; refreshImportControls(); }
}

async function drawPreview() {
  const original = await renderOriginal(pending, pending.index);
  const target = $('mask-canvas');
  const scale = Math.min(1, 760 / original.width, 950 / original.height);
  target.width = Math.max(1, Math.round(original.width * scale));
  target.height = Math.max(1, Math.round(original.height * scale));
  const preview = canvas(target.width, target.height);
  preview.getContext('2d').drawImage(original, 0, 0, preview.width, preview.height);
  pending.preview = preview;
  $('mask-page').textContent = (pending.index + 1) + ' / ' + pending.count + ' ページ';
  paintMasks();
}

function paintMasks() {
  const target = $('mask-canvas');
  const context = target.getContext('2d');
  context.drawImage(pending.preview, 0, 0);
  const masks = [...(pending.masks.get(pending.index) ?? [])];
  if (selection?.box) masks.push(selection.box);
  for (const box of masks) {
    const rectangle = [box.x * target.width, box.y * target.height, box.width * target.width, box.height * target.height];
    context.fillStyle = '#cc344650';
    context.strokeStyle = '#b52a40';
    context.lineWidth = 2;
    context.fillRect(...rectangle);
    context.strokeRect(...rectangle);
  }
}

async function changeMaskPage(index) {
  if (busy || !pending) return;
  busy = true;
  selection = null;
  const previous = pending.index;
  pending.index = index;
  refreshImportControls();
  try {
    await drawPreview();
    $('mask-canvas').parentElement.scrollTop = 0;
  } catch (error) {
    pending.index = previous;
    importStatus('プレビューを表示できませんでした。' + (error.message || String(error)));
  } finally { busy = false; refreshImportControls(); }
}

function maskPoint(event) {
  const bounds = $('mask-canvas').getBoundingClientRect();
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
    y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1)
  };
}

$('mask-canvas').addEventListener('pointerdown', (event) => {
  if (busy || !pending?.preview || selection || event.button !== 0) return;
  selection = { pointer: event.pointerId, start: maskPoint(event) };
  $('mask-canvas').setPointerCapture(event.pointerId);
});

$('mask-canvas').addEventListener('pointermove', (event) => {
  if (selection?.pointer !== event.pointerId) return;
  const point = maskPoint(event);
  const start = selection.start;
  selection.box = {
    x: Math.min(start.x, point.x),
    y: Math.min(start.y, point.y),
    width: Math.abs(start.x - point.x),
    height: Math.abs(start.y - point.y)
  };
  paintMasks();
});

for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  $('mask-canvas').addEventListener(type, (event) => {
    if (selection?.pointer !== event.pointerId) return;
    const box = selection.box;
    if (type === 'pointerup' && box?.width > .005 && box.height > .005) {
      const masks = pending.masks.get(pending.index) ?? [];
      masks.push(box);
      pending.masks.set(pending.index, masks);
    }
    selection = null;
    paintMasks();
    refreshImportControls();
  });
}

function splitSentences(text) {
  // 日本語の途中に入った改行や空白を取り除き、英単語間の空白は残す。
  const clean = text.trim()
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}、。！？ー])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}、。！？ー])/gu, '$1')
    .replace(/\s+/g, ' ');
  return (clean.match(/[^。]+(?:。+[」』）】”]*)?|。+/gu) ?? [])
    .map((line) => line.trim()).filter(Boolean);
}

function parsePageRange(value, totalPages) {
  const text = value
    .normalize('NFKC')
    .replace(/[、，]/g, ',')
    .replace(/[〜～−–—ー]/g, '~')
    .trim();

  if (!text) {
    return Array.from({ length: totalPages }, (_, index) => index);
  }

  const selected = new Set();

  for (const part of text.split(',')) {
    const match = part.trim().match(/^(\d+)(?:\s*[~\-]\s*(\d+))?$/);

    if (!match) {
      throw new Error(
        'ページ指定は「1,2~4,7」のように入力してください。'
      );
    }

    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);

    if (
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      first < 1 ||
      last > totalPages ||
      first > last
    ) {
      throw new Error(
        'ページは1〜' + totalPages +
        'の範囲で、小さい番号から指定してください。'
      );
    }

    for (let page = first; page <= last; page++) {
      selected.add(page - 1);
    }
  }

  return [...selected].sort((left, right) => left - right);
}

function paragraphSentences(data) {
  const output = [];

  for (const block of data.blocks ?? []) {
    const paragraphs = block.paragraphs ?? [];

    const blockLines = paragraphs
      .flatMap((paragraph) => paragraph.lines ?? [])
      .filter((line) => line.text?.trim());

    const positions = blockLines
      .filter((line) => Number.isFinite(line.bbox?.x0))
      .map((line) => line.bbox.x0);

    // 本文のまとまりごとに、通常の行頭位置を求める。
    const leftEdge = positions.length
      ? Math.min(...positions)
      : null;

    for (const paragraph of paragraphs) {
      let buffer = [];

      const flush = () => {
        output.push(...splitSentences(buffer.join('\n')));
        buffer = [];
      };

      for (const line of paragraph.lines ?? []) {
        if (!line.text?.trim()) continue;

        const box = line.bbox;
        const height = box ? box.y1 - box.y0 : 0;

        const offset =
          leftEdge === null || !Number.isFinite(box?.x0)
            ? 0
            : box.x0 - leftEdge;

        // 行の高さを文字サイズの目安にして、
        // 約1文字分の字下げを段落の始まりと推定する。
        const indented =
          height > 0 &&
          offset >= height * 0.6 &&
          offset <= height * 1.8;

        if (indented && buffer.length) {
          flush();
        }

        buffer.push(line.text);
      }

      // OCRが検出した段落の終わりでも区切る。
      flush();
    }
  }

  return output.length
    ? output
    : splitSentences(data.text ?? '');
}

function imageBlob(target) {
  return new Promise((resolve, reject) => {
    target.toBlob((blob) => blob ? resolve(blob) : reject(new Error('資料画像を保存できませんでした。')), 'image/png');
  });
}

async function importDocument(event) {
  event.preventDefault();
  if (busy || !pending) return;
  busy = true;
  selection = null;
  refreshImportControls();
  const source = pending;
  const titleInput = $('custom-title').value.trim();
  let worker;
  let pageNumber = 0;
    try {
    const selectedPages = parsePageRange(
      $('page-range').value,
      source.count
    );

    importStatus('日本語と英語のOCRを準備中…');
    const library = await loadOCR();
    let rejectStartup;
    let startupTimer;
    const startupFailure = new Promise((_, reject) => {
      rejectStartup = reject;
      startupTimer = setTimeout(() => reject(new Error('OCRの準備がタイムアウトしました。')), 90000);
    });
    const startup = library.createWorker(['jpn', 'eng'], 1, {
      logger: ({ status, progress }) => {
        if (status === 'recognizing text') {
          importStatus(
  pageNumber + ' / ' + selectedPages.length +
  ' ページを認識中… ' + Math.round(progress * 100) + '%'
);
        }
      },
      errorHandler: (error) => {
        if (!worker) rejectStartup(new Error(String(error)));
      }
    });
    try { worker = await Promise.race([startup, startupFailure]); }
    catch (error) {
      void startup.then((lateWorker) => lateWorker.terminate()).catch(() => {});
      throw error;
    } finally { clearTimeout(startupTimer); }
    await worker.setParameters({ tessedit_pageseg_mode: '3' });

        const pages = [];

    for (const [position, index] of selectedPages.entries()) {
      pageNumber = position + 1;

      importStatus(
        pageNumber + ' / ' + selectedPages.length +
        ' ページを処理中…（元資料 ' + (index + 1) + ' ページ）'
      );

      const original = await renderOriginal(source, index);
      const image = await imageBlob(original);

      const masks = $('exclude').checked
        ? source.masks.get(index) ?? []
        : [];

      const context = original.getContext('2d');
      context.fillStyle = '#fff';

      for (const box of masks) {
        context.fillRect(
          box.x * original.width,
          box.y * original.height,
          box.width * original.width,
          box.height * original.height
        );
      }

      const result = await worker.recognize(
  original,
  {},
  { text: true, blocks: true }
);

pages.push({
  image,
  lines: paragraphSentences(result.data),
  sourcePage: index + 1
});

      original.width = original.height = 1;
    }

    const firstText = pages.flatMap((page) => page.lines).join('');
    const beginning = Array.from(firstText.replace(/\s+/g, '')).slice(0, 10).join('');
    const entry = {
      id: crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16))).join('-'),
      title: titleInput || beginning || source.file.name.replace(/\.[^.]+$/, ''),
      fileName: source.file.name,
      created: Date.now(),
      pageCount: pages.length,
      memo: ''
    };
    const document = { id: entry.id, title: entry.title, pages };
    let saved = true;
    try {
      await storage(['documents', 'history'], 'readwrite', (transaction) => {
        transaction.objectStore('history').add(entry);
        return transaction.objectStore('documents').add(document);
      });
    } catch { saved = false; }

    displayDocument(document, '');
    $('import-dialog').close();
    showStatus(saved ? pages.length + ' ページを読み込みました。' : '資料を表示しました。ブラウザの保存領域に書き込めなかったため、履歴には残りません。');
  } catch (error) {
    importStatus('読み込みに失敗しました。通信状況やファイルを確認してください。' + (error.message || String(error)));
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    busy = false;
    refreshImportControls();
  }
}

async function showHistory() {
  const list = $('history-list');
  list.textContent = '履歴を取得中…';
  $('history-dialog').showModal();
  try {
    const entries = await storage(['history'], 'readonly', (transaction) => transaction.objectStore('history').getAll());
    list.textContent = entries.length ? '' : '読み込み履歴はまだありません。';
    for (const entry of entries.sort((left, right) => right.created - left.created)) {
      const button = document.createElement('button');
      button.className = 'history-entry';
      button.textContent = entry.title;
      const details = document.createElement('small');
      details.textContent = new Date(entry.created).toLocaleString('ja-JP') + ' ・ ' + entry.pageCount + ' ページ ・ ' + entry.fileName;
      button.append(details);
      button.onclick = async () => {
        button.disabled = true;
        try {
          const stored = await storage(['documents'], 'readonly', (transaction) => transaction.objectStore('documents').get(entry.id));
          if (!stored) throw new Error();
          if (!$('history-dialog').open) return;
          displayDocument(stored, entry.memo);
          $('history-dialog').close();
          showStatus('履歴から資料を開きました。');
        } catch { details.textContent = '資料を再表示できませんでした。'; }
        finally { button.disabled = false; }
      };
      list.append(button);
    }
  } catch { list.textContent = 'このブラウザでは履歴を取得できませんでした。'; }
}

async function saveMemo() {
  if (!state.document) return;
  const id = state.document.id;
  const memo = $('memo').value;
  $('save-memo').disabled = true;
  $('memo-status').textContent = '保存中…';
  try {
    const entry = await storage(['history'], 'readonly', (transaction) => transaction.objectStore('history').get(id));
    if (!entry) throw new Error();
    await storage(['history'], 'readwrite', (transaction) => transaction.objectStore('history').put({ ...entry, memo }));
    if (state.document.id === id) $('memo-status').textContent = 'メモを保存しました。';
  } catch {
    if (state.document.id === id) $('memo-status').textContent = 'メモを保存できませんでした。';
  } finally { $('save-memo').disabled = false; }
}

$('import').onclick = () => {
  if (busy) return;
  $('import-form').reset();
  pending = null;
  importStatus('');
  refreshImportControls();
  $('import-dialog').showModal();
};

$('import-dialog').addEventListener('cancel', (event) => {
  if (busy) event.preventDefault();
});

$('import-dialog').addEventListener('close', () => {
  if (pending?.pdf) void pending.pdf.destroy().catch(() => {});
  pending = null;
  selection = null;
  $('mask-canvas').width = 1;
});

$('file').onchange = () => prepareFile($('file').files[0]);
$('exclude').onchange = () => {
  refreshImportControls();
  if ($('exclude').checked && pending) void changeMaskPage(pending.index);
};
$('mask-prev').onclick = () => changeMaskPage(pending.index - 1);
$('mask-next').onclick = () => changeMaskPage(pending.index + 1);
$('mask-undo').onclick = () => {
  pending.masks.get(pending.index)?.pop();
  paintMasks();
  refreshImportControls();
};

$('import-form').onsubmit = importDocument;
$('history').onclick = showHistory;
$('settings').onclick = () => $('settings-dialog').showModal();

for (const button of document.querySelectorAll('[data-close]')) {
  button.onclick = () => button.closest('dialog').close();
}

$('size').oninput = $('color').oninput = saveSettings;
$('line-prev').onclick = $('previous-text').onclick = () => setLine(state.line - 1);
$('line-next').onclick = $('next-text').onclick = () => setLine(state.line + 1);
$('page-prev').onclick = () => setPage(state.page - 1);
$('page-next').onclick = () => setPage(state.page + 1);

for (const [id, setter, current] of [['line', setLine, () => state.line], ['page', setPage, () => state.page]]) {
  const input = $(id);
  input.onchange = () => setter(Number.isFinite(input.valueAsNumber) ? Math.trunc(input.valueAsNumber) - 1 : current());
  input.onkeydown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
  };
}

$('tools').onclick = () => toggleTools($('tool-panel').hidden);
$('close-tools').onclick = () => toggleTools(false);
$('lock').onchange = () => {
  if (!$('lock').checked && state.page !== state.readingPage) {
    state.readingPage = state.page;
    state.line = 0;
  }
  renderReading();
};
$('save-memo').onclick = saveMemo;

$('zoom-out').onclick = () => changeZoom(state.zoom / 1.25);
$('zoom-in').onclick = () => changeZoom(state.zoom * 1.25);
$('zoom-reset').onclick = () => changeZoom(1);

$('viewer').addEventListener('wheel', (event) => {
  if (!state.document || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  const bounds = $('viewer').getBoundingClientRect();
  changeZoom(state.zoom * Math.exp(-event.deltaY * .005), event.clientX - bounds.left, event.clientY - bounds.top);
}, { passive: false });

let pinchDistance = 0;
$('viewer').addEventListener('touchmove', (event) => {
  if (!state.document || event.touches.length !== 2) return;
  event.preventDefault();
  const [first, second] = event.touches;
  const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
  const bounds = $('viewer').getBoundingClientRect();
  if (pinchDistance > 0 && distance > 0) {
    changeZoom(state.zoom * distance / pinchDistance,
      (first.clientX + second.clientX) / 2 - bounds.left,
      (first.clientY + second.clientY) / 2 - bounds.top);
  }
  pinchDistance = distance;
}, { passive: false });

for (const type of ['touchend', 'touchcancel']) {
  $('viewer').addEventListener(type, () => { pinchDistance = 0; });
}

$('current-text').addEventListener('keydown', (event) => {
  if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  setLine(state.line + (event.key === 'ArrowUp' ? -1 : 1));
});

new ResizeObserver(fitTitle).observe($('title'));
new ResizeObserver(renderReading).observe($('ruler'));

$('size').oninput = () => {
  saveSettings();
  renderReading();
};

applySettings();
renderReading();
renderPage();