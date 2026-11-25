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
const settings = { size: 24, speed: 6, color: '#416bb6' };
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

const dictionaryBase = './kuromoji/';
const parsedSentences = new Map();
let tokenizer;
let tokenizerRequest;
let analysisFailed = false;
const analyzedPages = new WeakMap();
let pageAnalysis;
const playback = {
  frame: null, lastTime: null, distance: 0, page: null, anchor: null,
  sentenceStarts: [], end: 0, smallWidth: 0
};

function loadTokenizer() {
  if (tokenizerRequest) return tokenizerRequest;
  analysisFailed = false;
  tokenizerRequest = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = setTimeout(() => {
      script.remove();
      reject(new Error('辞書の読み込みがタイムアウトしました。'));
    }, 20000);
    const finish = (error, result) => {
      clearTimeout(timeout);
      script.remove();
      if (error) reject(error);
      else resolve(result);
    };
    script.src = dictionaryBase + 'build/kuromoji.js';
    script.onerror = () => finish(new Error('解析器を取得できませんでした。'));
    script.onload = () => {
      try { window.kuromoji.builder({ dicPath: dictionaryBase + 'dict/' }).build(finish); }
      catch (error) { finish(error); }
    };
    document.head.append(script);
  }).then(result => {
    tokenizer = result;
    analyzeReadingPage();
    updatePlaybackControls();
  }).catch(() => {
    tokenizerRequest = null;
    analysisFailed = true;
    updatePlaybackControls();
  });
  updatePlaybackControls();
  return tokenizerRequest;
}

function classifySentence(sentence) {
  if (!tokenizer) return [{ text: sentence, className: '' }];
  if (parsedSentences.has(sentence)) return parsedSentences.get(sentence);
  const tokens = tokenizer.tokenize(sentence);
  const runs = [];
  let offset = 0;
  for (const [index, token] of tokens.entries()) {
    const text = token.surface_form;
    const start = sentence.indexOf(text, offset);
    if (start < 0) continue;
    if (start > offset) runs.push({ text: sentence.slice(offset, start), className: '' });
    offset = start + text.length;
    const detail = token.pos_detail_1;
    let className = '';
    if (/^[0-9０-９]+$/u.test(text) || detail === '数') className = 'rr-large';
    else if (/^[\p{Script=Latin}][\p{Script=Latin}\p{Mark}\p{Number}'’.-]*$/u.test(text)) className = 'rr-middle rr-english';
    else if (token.pos === '名詞' && detail === '固有名詞') className = 'rr-large';
    else if (token.pos === '動詞' || token.pos === '形容詞' ||
      detail === '形容動詞語幹' || detail === 'サ変接続') {
      let next = index + 1;
      let predicate = token;
      if (detail === 'サ変接続' && tokens[next]?.pos === '動詞' &&
        ['する', '為る'].includes(tokens[next].basic_form)) predicate = tokens[next++];
      let past = false;
      let lastAuxiliary;
      while (tokens[next]?.pos === '助動詞') {
        past ||= tokens[next].basic_form === 'た';
        lastAuxiliary = tokens[next++];
      }
      const following = tokens[next];
      const modifiesNoun = following?.pos === '名詞';
      const terminal = (!following || /^[、。！？!?」』）】]+$/u.test(following.surface_form)) &&
        (lastAuxiliary ?? predicate).conjugated_form === '基本形';
      const existence = ['ある', '有る', '在る', 'いる', '居る', 'おる'].includes(predicate.basic_form);
      className = !existence && !modifiesNoun && (past || terminal) ? 'rr-large' : 'rr-middle';
    } else if ((token.pos === '名詞' && !['こと', '事'].includes(text) && detail !== '接尾') ||
      token.pos === '接続詞') className = 'rr-middle';
    runs.push({ text, className });
  }
  if (offset < sentence.length) runs.push({ text: sentence.slice(offset), className: '' });
  if (parsedSentences.size >= 500) parsedSentences.clear();
  parsedSentences.set(sentence, runs);
  return runs;
}

function analyzeReadingPage() {
  const page = state.document?.pages[state.readingPage];
  if (!tokenizer || !page?.lines.length || analyzedPages.has(page) || pageAnalysis === page) return;
  pageAnalysis = page;
  const runs = [];
  function analyzeBatch() {
    if (pageAnalysis !== page) return;
    if (state.document?.pages[state.readingPage] !== page) {
      pageAnalysis = undefined;
      return;
    }
    try {
      const started = performance.now();
      do {
        runs.push(classifySentence(page.lines[runs.length]));
      } while (runs.length < page.lines.length && performance.now() - started < 8);
    } catch {
      analyzedPages.set(page, []);
      pageAnalysis = undefined;
      $('playback-status').textContent = 'このページの品詞を解析できませんでした。';
      return;
    }
    if (runs.length < page.lines.length) {
      setTimeout(analyzeBatch, 0);
      return;
    }
    analyzedPages.set(page, runs);
    pageAnalysis = undefined;
    // 再生中は表示を作り直さず、停止後に適用する。
    if (playback.frame === null) renderReading();
  }
  setTimeout(analyzeBatch, 0);
}

function appendSentence(track, runs, highlight) {
  const element = document.createElement('span');
  element.className = 'rr-sentence';
  let offset = 0;
  for (const run of runs) {
    const span = document.createElement('span');
    span.className = run.className;
    const start = highlight ? Math.max(0, highlight.offset - offset) : 0;
    const end = highlight ? Math.min(run.text.length, highlight.offset + highlight.length - offset) : 0;
    if (start < end) {
      const mark = document.createElement('mark');
      mark.textContent = run.text.slice(start, end);
      span.append(run.text.slice(0, start), mark, run.text.slice(end));
    } else span.textContent = run.text;
    element.append(span);
    offset += run.text.length;
  }
  track.append(element);
}

function readingSentences() {
  return state.document?.pages[state.readingPage]?.lines ?? [];
}

function stopPlayback(applyAnalysis = false) {
  if (playback.frame !== null) cancelAnimationFrame(playback.frame);
  playback.frame = null;
  playback.lastTime = null;
  if (applyAnalysis) renderReading();
  else updatePlaybackControls();
}

function updatePlaybackControls() {
  const available = readingSentences().length > 0;
  const playing = playback.frame !== null;
  $('reading-play').disabled = !available || playing;
  $('reading-stop').disabled = !playing;
  $('reading-search').disabled = !state.document;
  $('playback-status').textContent = analysisFailed
    ? '品詞辞書を取得できません。通常サイズで表示しています。開始で再試行できます。'
    : tokenizerRequest && !tokenizer ? '品詞辞書を読み込み中…'
    : playing ? '再生中' : '';
}

function positionTrack() {
  const viewport = $('reading-window');
  $('reading-track').style.transform =
    'translateX(' + (viewport.clientWidth / 2 - playback.distance) + 'px)';
}

function measureTrack() {
  const track = $('reading-track');
  const left = track.getBoundingClientRect().left;
  playback.sentenceStarts = Array.from(track.children, child => child.getBoundingClientRect().left - left);
  playback.smallWidth = $('reading-measure').getBoundingClientRect().width;
  playback.end = track.getBoundingClientRect().width;
}

function updateSentenceControls(sentences) {
  const index = state.line;
  $('previous-text').textContent = sentences[index - 1] ?? '';
  $('next-text').textContent = sentences[index + 1] ?? '';
  $('line').value = sentences.length ? index + 1 : '';
  $('line').max = sentences.length;
  $('line').disabled = !sentences.length;
  $('line-total').textContent = sentences.length ? '/ ' + sentences.length + ' 文' : '文';
  $('previous-text').disabled = $('line-prev').disabled = index === 0;
  $('next-text').disabled = $('line-next').disabled = index + 1 >= sentences.length;
}

function renderReading() {
  const sentences = readingSentences();
  const page = state.document?.pages[state.readingPage];
  const viewport = $('reading-window');
  const track = $('reading-track');
  state.line = clamp(state.line, 0, Math.max(0, sentences.length - 1));
  $('reading-page').textContent = page
    ? '元資料 ' + (page.sourcePage ?? state.readingPage + 1) + 'ページの文章'
    : '';
  $('reading-placeholder').hidden = Boolean(sentences.length);
  $('reading-placeholder').textContent = state.document
    ? 'このページに認識された文章はありません。'
    : '資料を読み込むと、ここに文章が表示されます。';
  viewport.hidden = !sentences.length;

  const analysis = playback.page === page && playback.frame !== null
    ? playback.renderedAnalysis : analyzedPages.get(page);
  if (playback.page !== page || playback.renderedAnchor !== playback.anchor ||
      playback.renderedAnalysis !== analysis) {
    const oldStart = playback.sentenceStarts[state.line] ?? 0;
    const withinSentence = playback.renderedPage === page ? playback.distance - oldStart : 0;
    track.replaceChildren();
    sentences.forEach((sentence, index) => appendSentence(track,
      analysis?.[index] ?? [{ text: sentence, className: '' }],
      playback.anchor?.sentence === index ? playback.anchor : null));
    playback.page = playback.renderedPage = page;
    playback.renderedAnchor = playback.anchor;
    playback.renderedAnalysis = analysis;
    measureTrack();
    const mark = track.querySelector('mark');
    if (mark) {
      const bounds = mark.getBoundingClientRect();
      playback.distance = bounds.left - track.getBoundingClientRect().left;
    } else playback.distance = clamp((playback.sentenceStarts[state.line] ?? 0) + withinSentence, 0, playback.end);
  }
  positionTrack();
  updateSentenceControls(sentences);
  updatePlaybackControls();
  analyzeReadingPage();
}

function setLine(index) {
  stopPlayback();
  playback.anchor = null;
  state.line = clamp(index, 0, Math.max(0, readingSentences().length - 1));
  playback.distance = playback.sentenceStarts[state.line] ?? 0;
  renderReading();
}

function animateReading(now) {
  const previous = playback.lastTime ?? now;
  playback.lastTime = now;
  playback.distance += (now - previous) * settings.speed * playback.smallWidth / 1000;
  if (playback.distance >= playback.end) {
    const next = state.document.pages.findIndex((page, index) => index > state.readingPage && page.lines.length);
    if (next < 0) {
      playback.distance = playback.end;
      positionTrack();
      stopPlayback();
      return;
    }
    const overflow = playback.distance - playback.end;
    state.page = state.readingPage = next;
    state.line = 0;
    playback.anchor = null;
    renderPage();
    renderReading();
    playback.distance = Math.min(overflow, playback.end);
    positionTrack();
  } else {
    if (state.line + 1 < playback.sentenceStarts.length &&
      playback.distance >= playback.sentenceStarts[state.line + 1]) {
      state.line++;
      updateSentenceControls(readingSentences());
    }
    positionTrack();
  }
  playback.frame = requestAnimationFrame(animateReading);
}

function scrollReading(delta) {
  stopPlayback();
  if (playback.anchor) {
    playback.anchor = null;
    renderReading();
  }
  playback.distance = clamp(playback.distance + delta, 0, playback.end);

  let line = state.line;
  while (line > 0 && playback.distance < playback.sentenceStarts[line]) line--;
  while (line + 1 < playback.sentenceStarts.length &&
    playback.distance >= playback.sentenceStarts[line + 1]) line++;
  if (line !== state.line) {
    state.line = line;
    updateSentenceControls(readingSentences());
  }
  positionTrack();
}

const readingSurface = $('current-text');
let readingDrag = null;

readingSurface.addEventListener('pointerdown', (event) => {
  if (!event.isPrimary || event.button !== 0 || !readingSentences().length) return;
  readingDrag = { id: event.pointerId, x: event.clientX, active: false };
  readingSurface.setPointerCapture(event.pointerId);
});

readingSurface.addEventListener('pointermove', (event) => {
  if (readingDrag?.id !== event.pointerId) return;
  const delta = readingDrag.x - event.clientX;
  if (!readingDrag.active && Math.abs(delta) < 5) return;
  readingDrag.active = true;
  readingDrag.x = event.clientX;
  scrollReading(delta);
});

readingSurface.addEventListener('lostpointercapture', (event) => {
  if (readingDrag?.id === event.pointerId) readingDrag = null;
});

readingSurface.addEventListener('wheel', (event) => {
  const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
  if (!delta || !readingSentences().length) return;
  const unit = event.deltaMode === 1 ? playback.smallWidth :
    event.deltaMode === 2 ? $('reading-window').clientWidth : 1;
  event.preventDefault();
  scrollReading(delta * unit);
}, { passive: false });

function startPlayback() {
  if (!readingSentences().length || playback.frame !== null) return;
  if (!tokenizer && !tokenizerRequest) void loadTokenizer();
  if (playback.distance >= playback.end) setLine(0);
  playback.frame = requestAnimationFrame(animateReading);
  updatePlaybackControls();
}

function searchReading(event) {
  event.preventDefault();
  const query = $('reading-query').value.trim();
  const results = $('reading-results');
  results.replaceChildren();
  if (!query || !state.document) {
    $('reading-search-status').textContent = '検索語を入力してください。';
    return;
  }
  let count = 0;
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  for (const [pageIndex, page] of state.document.pages.entries()) {
    for (const [sentence, text] of page.lines.entries()) {
      for (const match of text.matchAll(pattern)) {
        count++;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = (page.sourcePage ?? pageIndex + 1) + 'ページ　' +
          text.slice(Math.max(0, match.index - 14), match.index + match[0].length + 14);
        button.onclick = () => {
          stopPlayback();
          state.page = state.readingPage = pageIndex;
          state.line = sentence;
          playback.anchor = { sentence, offset: match.index, length: match[0].length };
          renderPage();
          renderReading();
          $('reading-search-dialog').close();
        };
        results.append(button);
      }
    }
  }
  $('reading-search-status').textContent = count + '件';
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
    stopPlayback();
    playback.anchor = null;
    state.page = state.readingPage = page;
    state.line = 0;
    renderPage();
  } else $('page').value = page + 1;
  renderReading();
}

function toggleTools(open) {
  $('tool-panel').hidden = !open;
  $('tools').setAttribute('aria-expanded', String(open));
  if (open) $('close-tools').focus();
  else if (!$('tools').disabled) $('tools').focus();
}

function displayDocument(document, memo) {
  stopPlayback();
  playback.anchor = null;
  Object.assign(state, { document, page: 0, readingPage: 0, line: 0, zoom: 1 });
  $('memo').value = memo;
  $('memo-status').textContent = '';
  $('tool-panel').hidden = true;
  $('tools').setAttribute('aria-expanded', 'false');
  fitTitle();
  renderReading();
  renderPage();
  if (!tokenizer) void loadTokenizer();
}

function applySettings() {
  settings.size = clamp(Number(settings.size) || 24, 8, 48);

  document.documentElement.style.setProperty('--reading-size', settings.size + 'pt');
  document.documentElement.style.setProperty('--ruler', settings.color);

  $('size').value = settings.size;
  $('size-output').value = settings.size + ' pt';
  $('color').value = settings.color;
  settings.speed = clamp(Number(settings.speed) || 6, 1, 24);
  $('speed').value = settings.speed;
  $('speed-output').value = settings.speed + ' 文字分/秒';
}

function saveSettings() {
  settings.size = Number($('size').value);
  settings.color = $('color').value;
  settings.speed = Number($('speed').value);
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

    $('import-dialog').close();
    displayDocument(document, '');
    showStatus(saved ? pages.length + ' ページを読み込みました。' : '資料を表示しました。ブラウザの保存領域に書き込めなかったため、履歴には残りません。');
  } catch (error) {
    const message = '読み込みに失敗しました。' + (error.message || String(error));
    if ($('import-dialog').open) importStatus(message);
    else showStatus(message);
  } finally {
    if (worker) void worker.terminate().catch(() => {});
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

$('color').oninput = $('speed').oninput = saveSettings;
$('reading-play').onclick = startPlayback;
$('reading-stop').onclick = () => stopPlayback(true);
$('reading-search').onclick = () => {
  stopPlayback();
  $('reading-results').replaceChildren();
  $('reading-search-status').textContent = '';
  $('reading-search-dialog').showModal();
};
$('reading-search-form').onsubmit = searchReading;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPlayback();
});
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
$('save-memo').onclick = saveMemo;
const exportMemoButton = $('export-memo');
if (exportMemoButton) exportMemoButton.onclick = () => {
  if (!state.document) return;
  const memo = $('memo').value;
  if (!memo.trim()) {
    $('memo-status').textContent = '出力するメモを入力してください。';
    return;
  }

  const title = Array.from(state.document.title || '資料')
    .slice(0, 40).join('').replace(/[\\/:*?"<>|]/g, '_').trim();
  const file = new Blob([memo], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = (title || '資料') + '-メモ.txt';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};

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
  const previousSize = settings.size;
  saveSettings();
  if (settings.size !== previousSize && readingSentences().length) {
    playback.distance *= settings.size / previousSize;
    measureTrack();
  }
  renderReading();
};

applySettings();
renderReading();
renderPage();




