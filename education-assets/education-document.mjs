// Only authenticated document bytes enter this viewer. PDF actions are never run.
const libraryBase = new URL('./pdfjs-6.4.299/', import.meta.url);
export function createDocumentViewer(container, assertCurrent) {
  let generation = 0, loadingTask = null, renderTask = null;
  const imageUrls = new Set();
  function clear() {
    generation++;
    try { renderTask?.cancel(); } catch {}
    renderTask = null;
    const old = loadingTask; loadingTask = null;
    if (old) Promise.resolve(old.destroy()).catch(() => {});
    for (const url of imageUrls) URL.revokeObjectURL(url);
    imageUrls.clear();
    for (const canvas of container.querySelectorAll('canvas')) { canvas.width = 0; canvas.height = 0; }
    container.replaceChildren();
  }
  async function render(bytes, mime, title, imageUrl) {
    clear(); const mine = generation;
    const check = () => { assertCurrent(); if (mine !== generation) throw Error('資料の表示が取り消されました。'); };
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    status.textContent = '教材を表示しています…'; container.append(status);
    try {
      check();
      if (mime !== 'application/pdf') {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw Error('対応していない教材形式です。');
        const img = document.createElement('img'); img.alt = title; img.src = imageUrl;
        await img.decode(); check(); container.append(img); status.textContent = '教材を表示しました。内容をご確認ください。';
        return;
      }
      const pdfjs = await import('./pdfjs-6.4.299/pdf.min.mjs'); check();
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', libraryBase).href;
      const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false,
        stopAtErrors: true, cMapUrl: new URL('cmaps/', libraryBase).href, cMapPacked: true,
        standardFontDataUrl: new URL('standard_fonts/', libraryBase).href,
        wasmUrl: new URL('wasm/', libraryBase).href, iccUrl: new URL('iccs/', libraryBase).href });
      loadingTask = task;
      let passwordRequired = false;
      task.onPassword = () => { passwordRequired = true; Promise.resolve(task.destroy()).catch(() => {}); };
      let pdf;
      try { pdf = await task.promise; } catch (error) { if (passwordRequired) throw Error('パスワード付きPDFは表示できません。担当者にパスワードを外した教材を依頼してください。'); throw error; }
      check();
      let encodedBytes = 0;
      for (let index = 1; index <= pdf.numPages; index++) {
        const page = await pdf.getPage(index); check();
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(1.6, 1400 / base.width, Math.sqrt(2200000 / (base.width * base.height)));
        const viewport = page.getViewport({ scale });
        const section = document.createElement('section'), heading = document.createElement('h3');
        heading.textContent = `${index} / ${pdf.numPages} ページ`;
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        canvas.setAttribute('aria-label', `${title} ${index}ページ`);
        section.append(heading, canvas); container.append(section);
        const job = page.render({ canvasContext: canvas.getContext('2d'), viewport }); renderTask = job;
        await job.promise; check(); if (renderTask === job) renderTask = null;
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); check();
        if (!blob) throw Error('教材ページの画像を作成できませんでした。');
        encodedBytes += blob.size;
        if (encodedBytes > 32 * 1024 * 1024) throw Error('教材のページ画像が表示上限を超えています。担当者に資料の分割を依頼してください。');
        const image = document.createElement('img'), url = URL.createObjectURL(blob); imageUrls.add(url);
        image.loading = 'lazy'; image.decoding = 'async'; image.width = canvas.width; image.height = canvas.height;
        image.style.width = '100%'; image.style.height = 'auto'; image.alt = `${title} ${index}ページ`;
        image.src = url; canvas.replaceWith(image); canvas.width = 0; canvas.height = 0;
        const text = await page.getTextContent(); check();
        const details = document.createElement('details'), label = document.createElement('summary'), body = document.createElement('p');
        label.textContent = 'このページの文字を表示'; body.style.whiteSpace = 'pre-wrap';
        body.textContent = text.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('');
        details.append(label, body); section.append(details);
        status.textContent = `${index} / ${pdf.numPages} ページを表示しています…`; page.cleanup();
      }
      check(); status.textContent = `全 ${pdf.numPages} ページを表示しました。内容をご確認ください。`;
    } catch (error) {
      if (mine === generation) clear();
      throw error;
    }
  }
  return { render, clear };
}
