// ==UserScript==
// @name         语雀知识库批量下载（Markdown + 本地化图片）
// @namespace    https://7998888.xyz
// @version      1.2
// @description  批量导出语雀知识库文档为 Markdown，图片本地化（去水印下载），三态勾选目录树，打包 zip 下载
// @author       代可行
// @match        https://www.yuque.com/*
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      cdn.nlark.com
// @connect      www.yuque.com
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // 修复 JSZip 在 ScriptCat 沙箱中挂起的问题（setImmediate 用 setTimeout 兜底）
  (function patchSetImmediate() {
    var realSetTimeout = window.setTimeout;
    window.setImmediate = function (cb) {
      var args = Array.prototype.slice.call(arguments, 1);
      return realSetTimeout(function () { cb.apply(null, args); }, 0);
    };
    window.clearImmediate = function (id) { window.clearTimeout(id); };
  })();

  // ══════════════════════════════════════════════════════════════════
  //  配置
  // ══════════════════════════════════════════════════════════════════
  const CFG = {
    CONCURRENCY: 3,           // 文档间并发数
    REQUEST_DELAY: 500,       // 请求间隔（ms），避免频率限制
    POLL_INTERVALS: [1000, 2000, 3000],
  };

  const L = (...a) => console.log('[YuqueBatch]', ...a);
  const W = (...a) => console.warn('[YuqueBatch]', ...a);
  const E = (...a) => console.error('[YuqueBatch]', ...a);

  // ══════════════════════════════════════════════════════════════════
  //  公用工具
  // ══════════════════════════════════════════════════════════════════

  function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim(); }

  function upDir(path, n) {
    if (!path) return '';
    var parts = path.split('/').filter(Boolean);
    for (var i = 0; i < n; i++) parts.pop();
    return parts.join('/');
  }

  function relPath(fromDir, toPath) {
    var fromParts = fromDir ? fromDir.split('/').filter(Boolean) : [];
    var toParts = toPath.split('/').filter(Boolean);
    var i = 0;
    while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
    var ups = fromParts.length - i;
    var segs = [];
    for (var j = 0; j < ups; j++) segs.push('..');
    segs = segs.concat(toParts.slice(i));
    return segs.join('/');
  }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function fmtsz(b) {
    if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
    return b + ' B';
  }

  async function fetchWithRetry(url, options, retryOpts) {
    var maxRetries = (retryOpts && retryOpts.retries) || 3;
    var baseDelay = (retryOpts && retryOpts.baseDelay) || 1000;
    var retryStatuses = (retryOpts && retryOpts.retryStatuses) || [429, 500, 502, 503, 504];
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      var resp;
      try {
        resp = await fetch(url, options);
      } catch (e) {
        if (attempt < maxRetries) {
          await delay(baseDelay * Math.pow(2, attempt));
          continue;
        }
        throw e;
      }
      if (retryStatuses.indexOf(resp.status) !== -1 && attempt < maxRetries) {
        await delay(baseDelay * Math.pow(2, attempt));
        continue;
      }
      return resp;
    }
    throw new Error('fetchWithRetry 重试耗尽');
  }

  function getCsrfToken() {
    var m = document.cookie.match(/yuque_ctoken=([^;]+)/);
    return m ? m[1] : '';
  }

  // ══════════════════════════════════════════════════════════════════
  //  模块1：目录树（从 window.appData.book.toc 读取）
  // ══════════════════════════════════════════════════════════════════

  // ScriptCat 等管理器沙箱中 window 与页面真实 window 隔离，
  // 必须用 unsafeWindow 才能读到页面注入的 appData
  function realWin() {
    return (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  }

  function getBookId() {
    var w = realWin();
    if (w.appData && w.appData.book && w.appData.book.id) {
      return String(w.appData.book.id);
    }
    return '';
  }

  function getBookName() {
    var w = realWin();
    if (w.appData && w.appData.book && w.appData.book.name) {
      return w.appData.book.name;
    }
    return '语雀知识库';
  }

  function getTocList() {
    var w = realWin();
    if (w.appData && w.appData.book) {
      var toc = w.appData.book.toc;
      if (Array.isArray(toc)) return toc;
      // 兜底：个别版本 toc 可能是 { items: [...] } 结构
      if (toc && Array.isArray(toc.items)) return toc.items;
    }
    return [];
  }

  // 诊断用：返回 appData 各级状态快照
  function getTocState() {
    var w = realWin();
    var book = w.appData && w.appData.book ? w.appData.book : null;
    return {
      hasAppData: !!w.appData,
      hasBook: !!book,
      bookName: book ? book.name : '',
      bookId: book && book.id != null ? String(book.id) : '',
      tocType: book ? (book.toc == null ? 'null' : Array.isArray(book.toc) ? 'array' : typeof book.toc) : 'n/a',
      tocLen: book && Array.isArray(book.toc) ? book.toc.length : (book && book.toc && Array.isArray(book.toc.items) ? book.toc.items.length : -1),
    };
  }

  // 等待 appData.book.toc 就绪（SPA 时序兜底），最多 maxWaitMs 毫秒
  function waitForToc(maxWaitMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function poll() {
        var list = getTocList();
        if (list.length > 0) { resolve(list); return; }
        if (Date.now() - start >= maxWaitMs) { resolve([]); return; }
        setTimeout(poll, 250);
      })();
    });
  }

  // 用 parent_uuid 把扁平数组构建成树
  function buildTree(tocList) {
    var nodeMap = {};
    tocList.forEach(function (item) {
      nodeMap[item.uuid] = {
        uuid: item.uuid,
        title: item.title || '',
        type: item.type || 'DOC',       // DOC 文档 / TITLE 纯目录
        slug: item.url || '',
        docId: item.doc_id || item.id || '',
        children: [],
        hasChild: !!item.child_uuid,
      };
    });

    var roots = [];
    tocList.forEach(function (item) {
      var node = nodeMap[item.uuid];
      if (!node) return;
      if (item.parent_uuid && nodeMap[item.parent_uuid]) {
        nodeMap[item.parent_uuid].children.push(node);
      } else {
        roots.push(node);
      }
    });

    if (roots.length === 0) return null;
    if (roots.length === 1) return roots[0];
    // 多个根节点，构造虚拟根
    return {
      uuid: '__root__',
      title: getBookName(),
      type: 'TITLE',
      slug: '',
      docId: '',
      children: roots,
      hasChild: true,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  模块2：文档内容获取 + HTML → Markdown
  // ══════════════════════════════════════════════════════════════════

  async function getDocContent(slug, bookId) {
    var url = 'https://www.yuque.com/api/docs/' + slug
      + '?book_id=' + bookId
      + '&include_contributors=true&include_like=true&include_hits=true&merge_dynamic_data=false';

    var headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'x-csrf-token': getCsrfToken(),
    };

    var resp = await fetchWithRetry(url, { headers: headers, credentials: 'include' }, { retries: 3, baseDelay: 1000 });
    if (!resp.ok) throw new Error('文档获取 HTTP ' + resp.status);
    var data = await resp.json();
    if (!data.data) throw new Error('文档数据为空');
    return data.data;
  }

  function htmlToMarkdown(html) {
    html = String(html || '');
    html = html.replace(/<!doctype lake>/gi, '');
    html = html.replace(/<meta[^>]*>/gi, '');
    var parser = new DOMParser();
    var doc = parser.parseFromString(html, 'text/html');
    return processNode(doc.body);
  }

  function processChildren(node) {
    var result = '';
    for (var i = 0; i < node.childNodes.length; i++) {
      result += processNode(node.childNodes[i]);
    }
    return result;
  }

  function processNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    var tagName = node.tagName.toLowerCase();
    var result = '';

    switch (tagName) {
      case 'h1': result = '# ' + processChildren(node) + '\n\n'; break;
      case 'h2': result = '## ' + processChildren(node) + '\n\n'; break;
      case 'h3': result = '### ' + processChildren(node) + '\n\n'; break;
      case 'h4': result = '#### ' + processChildren(node) + '\n\n'; break;
      case 'h5': result = '##### ' + processChildren(node) + '\n\n'; break;
      case 'h6': result = '###### ' + processChildren(node) + '\n\n'; break;

      case 'p':
        var pContent = processChildren(node);
        result = pContent.trim() ? pContent + '\n\n' : '';
        break;

      case 'blockquote':
        if (node.classList && node.classList.contains('lake-alert')) {
          var alertType = node.classList.contains('lake-alert-info') ? '💡' :
            node.classList.contains('lake-alert-warning') ? '⚠️' :
            node.classList.contains('lake-alert-success') ? '✅' : '📌';
          var ac = processChildren(node);
          result = ac.split('\n').map(function (l) { return '> ' + alertType + ' ' + l; }).join('\n') + '\n\n';
        } else {
          var bc = processChildren(node);
          result = bc.split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n\n';
        }
        break;

      case 'ul':
      case 'ol':
        result = processList(node, tagName === 'ol' ? 1 : 0);
        break;

      case 'li':
        result = processChildren(node);
        break;

      case 'strong':
      case 'b':
        result = '**' + processChildren(node) + '**';
        break;

      case 'em':
      case 'i':
        result = '*' + processChildren(node) + '*';
        break;

      case 'code':
        if (node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre') {
          result = processChildren(node);
        } else {
          result = '`' + processChildren(node) + '`';
        }
        break;

      case 'pre':
        var codeContent = node.querySelector('code');
        var language = codeContent ? (codeContent.className.match(/language-(\w+)/) || [, ''])[1] : '';
        var code = codeContent ? codeContent.textContent : node.textContent;
        result = '```' + language + '\n' + code + '\n```\n\n';
        break;

      case 'a':
        var href = node.getAttribute('href') || '';
        var aText = processChildren(node);
        result = aText.trim() ? '[' + aText + '](' + href + ')' : '';
        break;

      case 'img':
        var src = node.getAttribute('src') || '';
        var alt = node.getAttribute('alt') || '';
        result = '![' + alt + '](' + src + ')\n\n';
        break;

      case 'br':
        result = '\n';
        break;

      case 'hr':
        result = '\n---\n\n';
        break;

      case 'table':
        result = processTable(node);
        break;

      case 'thead':
      case 'tbody':
      case 'tr':
      case 'th':
      case 'td':
        result = processChildren(node);
        break;

      case 'span':
      case 'div':
        result = processChildren(node);
        break;

      case 'card':
        result = processYuqueCard(node);
        break;

      default:
        result = processChildren(node);
    }

    return result;
  }

  function processList(node, startNum) {
    var items = node.querySelectorAll(':scope > li');
    var result = '';
    var counter = startNum;
    for (var i = 0; i < items.length; i++) {
      var content = processChildren(items[i]).trim();
      if (startNum > 0) {
        result += counter + '. ' + content + '\n';
        counter++;
      } else {
        result += '- ' + content + '\n';
      }
    }
    return result + '\n';
  }

  function processTable(table) {
    var rows = table.querySelectorAll('tr');
    if (rows.length === 0) return '';
    var result = '';
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].querySelectorAll('th, td');
      var cellContents = [];
      for (var j = 0; j < cells.length; j++) {
        cellContents.push(processChildren(cells[j]).trim());
      }
      result += '| ' + cellContents.join(' | ') + ' |\n';
      if (i === 0) {
        result += '| ' + cellContents.map(function () { return '---'; }).join(' | ') + ' |\n';
      }
    }
    return result + '\n';
  }

  function processYuqueCard(node) {
    var name = node.getAttribute('name') || '';
    var value = node.getAttribute('value') || '';
    if (!value) return '';
    var decodedValue;
    try { decodedValue = decodeURIComponent(value); } catch (e) { return ''; }
    var dataMatch = decodedValue.match(/^data:(.+)$/);
    if (!dataMatch) return '';
    try {
      var cardData = JSON.parse(dataMatch[1]);
      switch (name) {
        case 'codeblock':
          var code = cardData.code || '';
          var mode = cardData.mode || '';
          return '```' + mode + '\n' + code + '\n```\n\n';
        case 'image':
          var imgSrc = cardData.src || '';
          var imgName = cardData.name || '';
          return '![' + imgName + '](' + imgSrc + ')\n\n';
        case 'diagram':
          var diagramSrc = cardData.url || cardData.src || '';
          var diagramType = cardData.type || 'mermaid';
          return diagramSrc ? '![' + diagramType + '](' + diagramSrc + ')\n\n' : '';
        case 'localdoc':
          var docSrc = cardData.src || '';
          var docName = cardData.name || '';
          return '[' + docName + '](' + docSrc + ')\n\n';
        default:
          return '';
      }
    } catch (e) {
      return '';
    }
  }

  function cleanMarkdown(markdown) {
    markdown = markdown.replace(/\n{3,}/g, '\n\n');
    markdown = markdown.split('\n').map(function (l) { return l.trimEnd(); }).join('\n');
    markdown = markdown
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
    markdown = markdown.replace(/[\u200B-\u200D\uFEFF]/g, '');
    markdown = markdown.replace(/\u200B/g, '');
    return markdown.trim();
  }

  // ══════════════════════════════════════════════════════════════════
  //  模块3：图片本地化
  // ══════════════════════════════════════════════════════════════════

  // 去掉 OSS 水印/处理参数
  function cleanImageUrl(url) {
    var u = url;
    var qIdx = u.indexOf('?');
    if (qIdx >= 0) u = u.substring(0, qIdx);
    var ossIdx = u.indexOf('_x-oss-process');
    if (ossIdx >= 0) u = u.substring(0, ossIdx);
    return u;
  }

  function imageNameFromUrl(url) {
    var clean = cleanImageUrl(url);
    var parts = clean.split('/');
    var name = parts[parts.length - 1] || '';
    try { name = decodeURIComponent(name); } catch (e) {}
    if (!/\.(png|jpg|jpeg|gif|svg|webp|bmp)$/i.test(name)) name += '.png';
    return name;
  }

  async function downloadImage(url) {
    var clean = cleanImageUrl(url);
    var resp = await fetchWithRetry(clean, { credentials: 'omit' }, { retries: 2, baseDelay: 1000 });
    if (!resp.ok) throw new Error('图片下载 HTTP ' + resp.status);
    return await resp.arrayBuffer();
  }

  // 从 md 提取图片 URL，下载并本地化，返回 { md, imgCount }
  async function localizeImages(md, opts, masterZip) {
    // opts: { mdDir, attachName, attachBaseDir, docRel }
    var mdDir = opts.mdDir;
    var attachName = opts.attachName;
    var attachBaseDir = opts.attachBaseDir;
    var docRel = opts.docRel;

    // 收集所有图片引用（用 clean URL 去重）
    var imgRefs = [];
    var seen = {};
    md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (match, alt, url) {
      var clean = cleanImageUrl(url);
      if (!/^https?:\/\//i.test(clean)) return match;
      if (!seen[clean]) {
        seen[clean] = true;
        imgRefs.push({ alt: alt, url: clean, name: imageNameFromUrl(clean) });
      }
      return match;
    });

    // 下载图片，建立 url -> name 映射
    var urlToName = {};
    var images = [];
    for (var i = 0; i < imgRefs.length; i++) {
      var ref = imgRefs[i];
      try {
        var buf = await downloadImage(ref.url);
        // 处理重名：若文件名已被占用，加序号
        var finalName = ref.name;
        var used = {};
        for (var k = 0; k < images.length; k++) used[images[k].name] = true;
        if (used[finalName]) {
          var dot = finalName.lastIndexOf('.');
          var base = dot >= 0 ? finalName.substring(0, dot) : finalName;
          var ext = dot >= 0 ? finalName.substring(dot) : '';
          var n = 1;
          while (used[base + '_' + n + ext]) n++;
          finalName = base + '_' + n + ext;
        }
        images.push({ name: finalName, data: buf });
        urlToName[ref.url] = finalName;
      } catch (e) {
        W('图片下载失败，保留原链接:', ref.url, e.message);
      }
    }

    // 替换 md 里图片引用为本地相对路径
    md = md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (match, alt, url) {
      var clean = cleanImageUrl(url);
      if (!/^https?:\/\//i.test(clean)) return match;
      var name = urlToName[clean];
      if (!name) return match; // 下载失败，保留原链接
      var imgFullPath = [attachBaseDir, attachName, docRel, name].filter(Boolean).join('/');
      var rel = relPath(mdDir, imgFullPath);
      if (rel.indexOf('../') !== 0 && rel.indexOf('./') !== 0) rel = './' + rel;
      return '![' + alt + '](' + rel + ')';
    });

    // 写入图片到 masterZip
    for (var j = 0; j < images.length; j++) {
      var img = images[j];
      var imgFullPath = [attachBaseDir, attachName, docRel, img.name].filter(Boolean).join('/');
      masterZip.file(imgFullPath, img.data);
    }

    return { md: md, imgCount: images.length };
  }

  // ══════════════════════════════════════════════════════════════════
  //  模块4：UI
  // ══════════════════════════════════════════════════════════════════

  GM_addStyle(`
    .yq-toast { position:fixed; bottom:40px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.82); color:#fff; padding:10px 24px; border-radius:8px; font-size:14px; z-index:999999; font-family:sans-serif; pointer-events:none; transition:opacity .3s; }
    #yq-panel { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:600px; max-height:80vh; background:#fff; border:1px solid #e0e0e0; border-radius:12px; box-shadow:0 12px 48px rgba(0,0,0,.2); z-index:99999; display:flex; flex-direction:column; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; font-size:13px; }
    #yq-panel .yq-hd { padding:14px 20px; background:linear-gradient(135deg,#00b96b,#009456); color:#fff; font-weight:600; font-size:15px; display:flex; justify-content:space-between; align-items:center; }
    #yq-panel .yq-tree { flex:1; overflow-y:auto; padding:8px 0; max-height:50vh; }
    #yq-panel .yq-tree-node { display:flex; align-items:center; padding:5px 12px; cursor:pointer; user-select:none; }
    #yq-panel .yq-tree-node:hover { background:#f0f4ff; }
    #yq-panel .yq-tree-check { margin-right:8px; width:16px; height:16px; accent-color:#00b96b; }
    #yq-panel .yq-tree-expand { margin-right:4px; width:16px; text-align:center; font-size:10px; color:#999; }
    #yq-panel .yq-tree-title { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #yq-panel .yq-tree-type { margin-left:8px; font-size:11px; color:#999; flex-shrink:0; }
    #yq-panel .yq-prog { padding:8px 20px; border-top:1px solid #eee; max-height:150px; overflow-y:auto; font-size:12px; }
    #yq-panel .yq-prog-item { display:flex; align-items:center; padding:3px 0; gap:8px; }
    #yq-panel .yq-prog-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #yq-panel .yq-prog-status { flex-shrink:0; font-size:11px; }
    #yq-panel .yq-bar-wrap { padding:4px 20px 8px; }
    #yq-panel .yq-bar { width:100%; height:6px; background:#eee; border-radius:3px; overflow:hidden; }
    #yq-panel .yq-bar-fill { width:0%; height:100%; background:linear-gradient(90deg,#00b96b,#009456); border-radius:3px; transition:width .3s; }
    #yq-panel .yq-act { padding:10px 20px 14px; display:flex; gap:10px; align-items:center; border-top:1px solid #eee; }
    #yq-panel .yq-btn { padding:8px 20px; border:none; border-radius:6px; cursor:pointer; font-size:13px; font-weight:600; }
    #yq-panel .yq-btn-primary { background:linear-gradient(135deg,#00b96b,#009456); color:#fff; }
    #yq-panel .yq-btn-primary:hover { opacity:0.9; }
    #yq-panel .yq-btn-primary:disabled { opacity:0.5; cursor:not-allowed; }
    #yq-panel .yq-btn-cancel { border:1px solid #ddd; background:#fff; color:#666; }
    #yq-panel .yq-count { flex:1; font-size:12px; color:#888; }
    #yq-panel .yq-hd-btn { background:rgba(255,255,255,0.2); color:#fff; border:1px solid rgba(255,255,255,0.45); border-radius:4px; padding:2px 10px; cursor:pointer; font-size:12px; }
    #yq-panel .yq-hd-btn:hover { background:rgba(255,255,255,0.32); }
    #yq-panel .yq-cfg { padding:8px 20px; border-bottom:1px solid #eee; display:flex; gap:12px; align-items:center; font-size:12px; color:#555; }
    #yq-panel .yq-cfg input { width:90px; padding:4px 8px; border:1px solid #ddd; border-radius:4px; font-size:12px; }
    #yq-panel .yq-cfg select { padding:4px 6px; border:1px solid #ddd; border-radius:4px; font-size:12px; }
    #yq-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.3); z-index:99998; }
    .yq-float { position:fixed; right:20px; bottom:20px; z-index:999999; background:linear-gradient(135deg,#00b96b,#009456); color:#fff; padding:12px 18px; border-radius:20px; box-shadow:0 4px 16px rgba(0,0,0,.25); cursor:pointer; font-size:13px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; display:flex; align-items:center; gap:8px; }
  `);

  function showToast(msg, dur) {
    var old = document.querySelector('.yq-toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.className = 'yq-toast';
    el.textContent = msg;
    el.style.opacity = '1';
    document.body.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; setTimeout(function () { el.remove(); }, 300); }, dur || 3000);
  }

  function flattenTree(node, list) {
    list = list || [];
    if (node.type === 'DOC') list.push(node);
    for (var i = 0; i < node.children.length; i++) {
      flattenTree(node.children[i], list);
    }
    return list;
  }

  var panelOpen = false;
  var activePanel = null;
  var activeOverlay = null;
  var downloadRunning = false;
  var floatBox = null;

  function showPanel(tree) {
    if (panelOpen) return;
    panelOpen = true;

    var selected = new Set();
    var allNodes = flattenTree(tree);
    var nodeMap = {};
    var parentMap = {};
    var checkEls = {};
    (function indexTree(node, parent) {
      nodeMap[node.uuid] = node;
      if (parent) parentMap[node.uuid] = parent.uuid;
      for (var i = 0; i < node.children.length; i++) indexTree(node.children[i], node);
    })(tree, null);
    allNodes.forEach(function (n) { selected.add(n.uuid); });

    var overlay = document.createElement('div');
    overlay.id = 'yq-overlay';
    document.body.appendChild(overlay);

    var panel = document.createElement('div');
    panel.id = 'yq-panel';

    var hd = document.createElement('div');
    hd.className = 'yq-hd';
    hd.innerHTML = '<span>📗 语雀知识库批量导出 Markdown</span><span style="display:flex;align-items:center;gap:8px;"><button class="yq-hd-btn" id="yq-sel-all">全选</button><button class="yq-hd-btn" id="yq-sel-none">全不选</button><span id="yq-close" style="cursor:pointer;font-size:18px;line-height:1;padding:0 4px;">×</span></span>';
    panel.appendChild(hd);

    var cfgDiv = document.createElement('div');
    cfgDiv.className = 'yq-cfg';
    cfgDiv.innerHTML = '<span>附件目录名</span><input id="yq-attach-name" type="text" value="images">' +
      '<span>附件层级</span><select id="yq-attach-level">' +
      '<option value="0">同级</option>' +
      '<option value="1">上一级</option>' +
      '<option value="2">上上级</option>' +
      '</select>';
    panel.appendChild(cfgDiv);

    var treeDiv = document.createElement('div');
    treeDiv.className = 'yq-tree';
    renderTree(treeDiv, tree, selected, 0);
    panel.appendChild(treeDiv);

    var progDiv = document.createElement('div');
    progDiv.className = 'yq-prog';
    progDiv.style.display = 'none';
    panel.appendChild(progDiv);

    var barWrap = document.createElement('div');
    barWrap.className = 'yq-bar-wrap';
    barWrap.style.display = 'none';
    var bar = document.createElement('div');
    bar.className = 'yq-bar';
    var barFill = document.createElement('div');
    barFill.className = 'yq-bar-fill';
    bar.appendChild(barFill);
    barWrap.appendChild(bar);
    panel.appendChild(barWrap);

    var act = document.createElement('div');
    act.className = 'yq-act';
    var countSpan = document.createElement('span');
    countSpan.className = 'yq-count';
    countSpan.id = 'yq-count';
    updateCount();
    var btnGo = document.createElement('button');
    btnGo.className = 'yq-btn yq-btn-primary';
    btnGo.textContent = '🚀 开始导出';
    var btnCancel = document.createElement('button');
    btnCancel.className = 'yq-btn yq-btn-cancel';
    btnCancel.textContent = '关闭';
    act.appendChild(countSpan);
    act.appendChild(btnCancel);
    act.appendChild(btnGo);
    panel.appendChild(act);

    document.body.appendChild(panel);

    activePanel = panel;
    activeOverlay = overlay;

    function updateCount() {
      countSpan.textContent = '已选 ' + selected.size + ' 个文档';
    }

    function renderTree(container, node, selected, depth) {
      var row = document.createElement('div');
      row.className = 'yq-tree-node';

      var indent = document.createElement('span');
      indent.style.cssText = 'display:inline-block;width:' + (depth * 20) + 'px;flex-shrink:0;';
      row.appendChild(indent);

      if (node.children && node.children.length > 0) {
        var expand = document.createElement('span');
        expand.className = 'yq-tree-expand';
        var defaultExpand = (depth === 0);
        expand.textContent = defaultExpand ? '▼' : '▶';
        expand.dataset.expanded = defaultExpand ? 'true' : 'false';
        expand.style.cursor = 'pointer';
        row.appendChild(expand);
      } else {
        var spacer = document.createElement('span');
        spacer.className = 'yq-tree-expand';
        spacer.textContent = '·';
        row.appendChild(spacer);
      }

      if (node.type === 'DOC') {
        var check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'yq-tree-check';
        check.checked = selected.has(node.uuid);
        checkEls[node.uuid] = check;
        check.addEventListener('change', function () {
          setDescendants(node, this.checked);
          refreshAncestors(node);
          updateCount();
        });
        row.appendChild(check);
      } else {
        // TITLE 目录节点：也放一个复选框用于全选子节点
        var checkT = document.createElement('input');
        checkT.type = 'checkbox';
        checkT.className = 'yq-tree-check';
        checkT.checked = selected.has(node.uuid);
        checkEls[node.uuid] = checkT;
        checkT.addEventListener('change', function () {
          setDescendants(node, this.checked);
          refreshAncestors(node);
          updateCount();
        });
        row.appendChild(checkT);
      }

      var title = document.createElement('span');
      title.className = 'yq-tree-title';
      title.textContent = node.title || node.slug || node.uuid;
      row.appendChild(title);

      var type = document.createElement('span');
      type.className = 'yq-tree-type';
      type.textContent = node.type === 'DOC' ? 'doc' : '目录';
      row.appendChild(type);

      container.appendChild(row);

      if (node.children && node.children.length > 0) {
        var childDiv = document.createElement('div');
        childDiv.style.display = (depth === 0) ? 'block' : 'none';
        for (var i = 0; i < node.children.length; i++) {
          renderTree(childDiv, node.children[i], selected, depth + 1);
        }
        container.appendChild(childDiv);

        if (row.querySelector('.yq-tree-expand')) {
          row.querySelector('.yq-tree-expand').addEventListener('click', function (e) {
            e.stopPropagation();
            var expanded = this.dataset.expanded === 'true';
            this.dataset.expanded = expanded ? 'false' : 'true';
            this.textContent = expanded ? '▶' : '▼';
            childDiv.style.display = expanded ? 'none' : 'block';
          });
        }
      }
    }

    function collectDocDescendants(node, list) {
      for (var i = 0; i < node.children.length; i++) {
        var child = node.children[i];
        if (child.type === 'DOC') list.push(child);
        collectDocDescendants(child, list);
      }
    }

    function setDescendants(node, checked) {
      if (node.type === 'DOC') {
        if (checked) selected.add(node.uuid);
        else selected.delete(node.uuid);
        if (checkEls[node.uuid]) {
          checkEls[node.uuid].checked = checked;
          checkEls[node.uuid].indeterminate = false;
        }
      }
      for (var i = 0; i < node.children.length; i++) {
        setDescendants(node.children[i], checked);
      }
    }

    function refreshNodeState(node) {
      var el = checkEls[node.uuid];
      if (!el) return;
      var list = [];
      if (node.type === 'DOC') list.push(node);
      collectDocDescendants(node, list);
      var checkedCount = 0;
      for (var i = 0; i < list.length; i++) {
        if (selected.has(list[i].uuid)) checkedCount++;
      }
      if (list.length === 0 || checkedCount === 0) {
        el.checked = false;
        el.indeterminate = false;
      } else if (checkedCount === list.length) {
        el.checked = true;
        el.indeterminate = false;
      } else {
        el.checked = false;
        el.indeterminate = true;
      }
    }

    function refreshAncestors(node) {
      var parentUuid = parentMap[node.uuid];
      while (parentUuid) {
        refreshNodeState(nodeMap[parentUuid]);
        parentUuid = parentMap[parentUuid];
      }
    }

    function selectAll(checked) {
      for (var i = 0; i < allNodes.length; i++) {
        var n = allNodes[i];
        if (checked) selected.add(n.uuid);
        else selected.delete(n.uuid);
        var el = checkEls[n.uuid];
        if (el) { el.checked = checked; el.indeterminate = false; }
      }
      updateCount();
    }

    function closePanel() {
      if (downloadRunning) {
        panel.style.display = 'none';
        overlay.style.display = 'none';
        showFloatBox();
        return;
      }
      panel.remove();
      overlay.remove();
      panelOpen = false;
      activePanel = null;
      activeOverlay = null;
    }

    function showFloatBox() {
      if (floatBox) return;
      floatBox = document.createElement('div');
      floatBox.className = 'yq-float';
      floatBox.textContent = '📥 导出进行中，点击查看进度';
      floatBox.onclick = function () {
        if (floatBox) { floatBox.remove(); floatBox = null; }
        if (activePanel) activePanel.style.display = 'flex';
        if (activeOverlay) activeOverlay.style.display = 'block';
      };
      document.body.appendChild(floatBox);
    }

    document.getElementById('yq-close').onclick = closePanel;
    document.getElementById('yq-sel-all').onclick = function () { selectAll(true); };
    document.getElementById('yq-sel-none').onclick = function () { selectAll(false); };
    btnCancel.onclick = closePanel;
    overlay.onclick = closePanel;

    // 开始导出
    btnGo.onclick = async function () {
      var uuids = Array.from(selected);
      if (uuids.length === 0) {
        showToast('⚠ 请至少选择一个文档');
        return;
      }

      downloadRunning = true;
      btnGo.disabled = true;
      btnGo.textContent = '⏳ 导出中...';
      progDiv.style.display = 'block';
      barWrap.style.display = 'block';

      var bookId = getBookId();

      // 构建路径映射（叶子不建文件夹）
      var pathMap = {};
      (function buildPaths(node, prefix) {
        var dir;
        if (node.children && node.children.length > 0) {
          dir = prefix ? prefix + '/' + safeName(node.title) : safeName(node.title);
        } else {
          dir = prefix || '';
        }
        pathMap[node.uuid] = dir;
        for (var i = 0; i < node.children.length; i++) {
          buildPaths(node.children[i], dir);
        }
      })(tree, '');

      var attachName = (document.getElementById('yq-attach-name').value || '').trim() || 'images';
      var attachLevel = parseInt(document.getElementById('yq-attach-level').value, 10) || 0;

      if (typeof JSZip === 'undefined') {
        showToast('❌ JSZip 未加载，请检查网络后刷新重试');
        downloadRunning = false;
        btnGo.disabled = false;
        btnGo.textContent = '🚀 开始导出';
        return;
      }
      var masterZip = new JSZip();

      var total = uuids.length;
      var done = 0, success = 0, failed = 0;

      async function processOne(uuid) {
        var node = nodeMap[uuid];
        if (!node || node.type !== 'DOC' || !node.slug) {
          failed++;
          return;
        }

        var name = node.title || node.slug;
        var mdDir = pathMap[uuid] || '';
        var mdPath = (mdDir ? mdDir + '/' : '') + safeName(name) + '.md';
        var docPathNoExt = (mdDir ? mdDir + '/' : '') + safeName(name);
        var attachBaseDir = upDir(mdDir, attachLevel);
        var docRel = relPath(attachBaseDir, docPathNoExt);

        var item = document.createElement('div');
        item.className = 'yq-prog-item';
        item.innerHTML = '<span class="yq-prog-name" title="' + name + '">' + name + '</span><span class="yq-prog-status" style="color:#f90;">⏳</span>';
        progDiv.appendChild(item);
        progDiv.scrollTop = progDiv.scrollHeight;

        try {
          item.querySelector('.yq-prog-status').textContent = '📄 获取';
          var doc = await getDocContent(node.slug, bookId);

          item.querySelector('.yq-prog-status').textContent = '🔁 转换';
          var md = '# ' + (doc.title || name) + '\n\n';
          if (doc.content) md += htmlToMarkdown(doc.content);
          md = cleanMarkdown(md);

          item.querySelector('.yq-prog-status').textContent = '🖼️ 图片';
          var result = await localizeImages(md, {
            mdDir: mdDir,
            attachName: attachName,
            attachBaseDir: attachBaseDir,
            docRel: docRel,
          }, masterZip);

          masterZip.file(mdPath, result.md);
          L('Collected:', mdPath, '+', result.imgCount, 'images');

          item.querySelector('.yq-prog-status').textContent = '✅';
          item.querySelector('.yq-prog-status').style.color = '#4caf50';
          success++;
        } catch (e) {
          E('导出失败:', name, e);
          item.querySelector('.yq-prog-status').textContent = '❌';
          item.querySelector('.yq-prog-status').style.color = '#f44336';
          item.querySelector('.yq-prog-status').title = e.message || String(e);
          item.title = e.message || String(e);
          failed++;
        }

        done++;
        barFill.style.width = (done * 100 / total) + '%';
        countSpan.textContent = done + '/' + total + ' 完成';
      }

      var queue = uuids.slice();
      async function worker() {
        while (queue.length > 0) {
          var uuid = queue.shift();
          await processOne(uuid);
          if (queue.length > 0) await delay(CFG.REQUEST_DELAY);
        }
      }

      var workers = [];
      for (var w = 0; w < CFG.CONCURRENCY; w++) workers.push(worker());
      await Promise.all(workers);

      btnGo.textContent = '📦 打包中...';
      countSpan.textContent = '成功 ' + success + ' / 失败 ' + failed + '，正在打包...';

      var finalBlob = await masterZip.generateAsync({ type: 'blob' }, function (meta) {
        countSpan.textContent = '打包中 ' + Math.round(meta.percent) + '%';
      });

      var ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      saveBlob(finalBlob, '语雀导出_' + ts + '.zip');

      btnGo.textContent = '✅ 导出完成';
      btnGo.disabled = false;
      countSpan.textContent = '成功 ' + success + ' / 失败 ' + failed + ' / 共 ' + total;

      if (typeof GM_notification === 'function') {
        GM_notification({ text: '语雀批量导出完成：' + success + '/' + total, timeout: 5000 });
      }
      downloadRunning = false;
      if (floatBox) { floatBox.remove(); floatBox = null; }
      if (activePanel && activePanel.style.display === 'none') {
        activePanel.style.display = 'flex';
        if (activeOverlay) activeOverlay.style.display = 'block';
      }
      showToast('✅ 导出完成：' + success + '/' + total + ' 个文档', 5000);
    };
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.cssText = 'display:none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 60000);
  }

  // ══════════════════════════════════════════════════════════════════
  //  入口：注入按钮
  // ══════════════════════════════════════════════════════════════════

  var btnInjected = false;

  async function openBatchPanel() {
    // 面板已打开（可能被隐藏遮挡），直接恢复显示
    if (panelOpen && activePanel) {
      L('面板已存在，恢复显示');
      activePanel.style.display = 'flex';
      if (activeOverlay) activeOverlay.style.display = 'block';
      return;
    }

    L('openBatchPanel 触发, URL=', location.href, 'state=', getTocState());

    var tocList = getTocList();
    if (tocList.length === 0) {
      // appData 可能尚未就绪，轮询等待最多 5 秒（SPA 时序兜底）
      showToast('⏳ 正在等待目录树加载...', 2000);
      tocList = await waitForToc(5000);
    }

    if (tocList.length === 0) {
      var st = getTocState();
      var hint;
      if (!st.hasAppData) {
        hint = '当前页面未注入 appData，请确认打开的是语雀知识库文档页';
      } else if (!st.hasBook) {
        hint = '当前页面没有 book 数据（appData=' + (st.hasAppData ? '有' : '无') + '），请在知识库【文档页】内操作，不要在首页/主页/团队页';
      } else {
        hint = 'book.toc 类型=' + st.tocType + '，目录树为空，请刷新页面后重试';
      }
      E('未找到目录树:', location.href, st);
      showToast('⚠ 未找到目录树：' + hint, 6000);
      return;
    }

    L('目录树加载成功, 节点数=', tocList.length, 'book=', getBookName());
    var tree = buildTree(tocList);
    if (!tree) {
      showToast('⚠ 目录树为空');
      return;
    }
    showPanel(tree);
  }

  function registerMenuCommand() {
    var fn = (typeof GM_registerMenuCommand === 'function')
      ? GM_registerMenuCommand
      : (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.GM_registerMenuCommand === 'function')
        ? unsafeWindow.GM_registerMenuCommand.bind(unsafeWindow)
        : null;
    if (!fn) {
      W('当前脚本管理器不支持 GM_registerMenuCommand');
      return;
    }
    try {
      fn('📥 批量导出语雀知识库', openBatchPanel);
      L('已注册菜单命令「批量导出语雀知识库」');
    } catch (e) {
      W('注册菜单命令失败:', e);
    }
  }

  function injectButton(retries) {
    if (retries === undefined) retries = 40;
    if (btnInjected || document.getElementById('yq-main-btn')) return;
    if (retries <= 0) { W('按钮注入超时'); return; }
    if (!document.body) {
      setTimeout(function () { injectButton(retries - 1); }, 500);
      return;
    }

    var btn = document.createElement('button');
    btn.id = 'yq-main-btn';
    btn.textContent = '📥 批量导出';
    btn.title = '批量导出语雀知识库所有文档为 Markdown（图片本地化）';
    Object.assign(btn.style, {
      position: 'fixed',
      top: '100px',
      right: '20px',
      zIndex: '9999',
      padding: '10px 16px',
      background: 'linear-gradient(135deg,#00b96b,#009456)',
      color: '#fff',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      fontSize: '14px',
      fontWeight: '600',
      boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
    });

    btn.onclick = openBatchPanel;

    document.body.appendChild(btn);
    btnInjected = true;
  }

  registerMenuCommand();
  injectButton();
  window.addEventListener('DOMContentLoaded', injectButton);
  window.addEventListener('load', function () { setTimeout(injectButton, 500); });

  L('脚本已启动 v1.2, URL=', location.href, 'toc 状态=', getTocState());

  // SPA 导航监听
  var lastUrl = location.href;
  new MutationObserver(function () {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      btnInjected = false;
      setTimeout(injectButton, 1000);
    }
  }).observe(document, { subtree: true, childList: true });

})();
