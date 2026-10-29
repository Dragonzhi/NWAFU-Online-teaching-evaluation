// ==UserScript==
// @name         NWAFU 网上评教辅助
// @namespace    https://github.com/Dragonzhi/NWAFU-Online-teaching-evaluation
// @version      2.2.3
// @description  在已登录的评教页面自动填写并提交问卷；支持全自动、自检和页面适配
// @author       Dragonzhi
// @updateURL    https://fastly.jsdelivr.net/gh/Dragonzhi/NWAFU-Online-teaching-evaluation@main/nwafu-eval.user.js
// @downloadURL  https://fastly.jsdelivr.net/gh/Dragonzhi/NWAFU-Online-teaching-evaluation@main/nwafu-eval.user.js
// @match        https://newehall.nwafu.edu.cn/*
// @match        https://*.nwafu.edu.cn/*
// @exclude      https://authserver.nwafu.edu.cn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  if (window.__NWAFU_EVAL_LOADED__) return;
  window.__NWAFU_EVAL_LOADED__ = true;

  var VERSION = '2.2.3';
  var KEYS = {
    settings: 'nwafu-eval:settings:v3',
    history: 'nwafu-eval:history:v2',
    position: 'nwafu-eval:panel-position:v2',
    collapsed: 'nwafu-eval:panel-collapsed:v2'
  };

  var DEFAULT_SETTINGS = {
    optionText: '完全赞同',
    fallbackOptions: ['非常赞同', '满意', '非常满意', '优秀'],
    comments: [
      '教师教学认真，讲解清晰，收获很大。',
      '课程内容充实，老师负责，整体体验很好。',
      '老师讲课有耐心，重点突出，受益良多。',
      '教学组织合理，课堂氛围好，推荐这门课。',
      '老师认真负责，答疑及时，课程很有帮助。'
    ],
    intervalMs: 500,
    confirmEach: false,
    maxCount: 50,
    overwriteChecked: false,
    fillEmptyOnly: true
  };

  var state = {
    settings: loadSettings(),
    running: false,
    autoSubmitting: false,
    stopRequested: false,
    currentItem: null,
    processed: new Set(),
    lastComment: null,
    logLines: [],
    panel: null,
    forceShow: null,
    lastSignature: '',
    refreshTimer: null,
    lastSelfCheck: null
  };

  // ---------------------------------------------------------------------------
  // 基础工具
  // ---------------------------------------------------------------------------

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function textOf(el) {
    if (!el) return '';
    var text = el.innerText || el.textContent || el.value || '';
    return String(text).replace(/\s+/g, ' ').trim();
  }

  function normalize(text) {
    return String(text || '').replace(/\s+/g, '');
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function waitFor(fn, timeout, interval) {
    var limit = timeout == null ? 15000 : timeout;
    var step = interval == null ? 200 : interval;
    var end = Date.now() + limit;
    var lastError = null;
    while (Date.now() < end) {
      try {
        var value = fn();
        if (value) return value;
      } catch (err) {
        lastError = err;
      }
      await sleep(step);
    }
    throw new Error('等待超时' + (lastError ? '：' + lastError.message : ''));
  }

  function zIndex(el) {
    var view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var value = parseInt(view.getComputedStyle(el).zIndex, 10);
    return isNaN(value) ? 0 : value;
  }

  function pageText() {
    if (!document.body) return '';
    return String(document.body.innerText || '').slice(0, 20000);
  }

  function log(message, type) {
    var line = {
      time: new Date().toLocaleTimeString(),
      message: String(message),
      type: type || 'info'
    };
    state.logLines.push(line);
    if (state.logLines.length > 200) state.logLines.shift();
    try { console.log('[NWAFU-Eval]', message); } catch (e) { /* ignore */ }
    renderLog();
  }

  function loadSettings() {
    try {
      var saved = JSON.parse(localStorage.getItem(KEYS.settings) || '{}');
      return Object.assign({}, DEFAULT_SETTINGS, saved || {});
    } catch (err) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function saveSettings() {
    try { localStorage.setItem(KEYS.settings, JSON.stringify(state.settings)); } catch (err) { /* ignore */ }
  }

  function loadHistory() {
    try {
      var data = JSON.parse(localStorage.getItem(KEYS.history) || '[]');
      return Array.isArray(data) ? data : [];
    } catch (err) {
      return [];
    }
  }

  function saveHistoryEntry(entry) {
    var history = loadHistory();
    history.push(entry);
    try { localStorage.setItem(KEYS.history, JSON.stringify(history.slice(-500))); } catch (err) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // 页面识别
  // ---------------------------------------------------------------------------

  function hasEvaluationText() {
    var text = pageText();
    return /评教|教学评价|教学质量评价|未提交|已提交/.test(text);
  }

  function isEvaluationPage() {
    if (!document.body) return false;
    if (!hasEvaluationText()) return false;
    return getPageKind() !== 'unknown' || /评教|教学评价/.test(pageText());
  }

  function getPageKind() {
    var scope = getFormScope();
    if (getAllRadioGroups(scope).length > 0 || getTextareas(scope).length > 0) return 'form';
    if (getPendingCandidates().length > 0) return 'list';
    if (/已提交/.test(pageText()) && /评教|教学评价/.test(pageText())) return 'list';
    return 'unknown';
  }

  function getAccessibleDocuments() {
    var docs = [document];
    $$('iframe').forEach(function (frame) {
      try {
        if (frame.contentDocument && frame.contentDocument.body) docs.push(frame.contentDocument);
      } catch (err) { /* cross-origin */ }
    });
    return docs;
  }

  function getVisibleDialogs(root) {
    return $$('[role="dialog"], .bh-dialog, .bh-paper-pile-dialog, .ant-modal, .el-dialog, [class*="dialog"], [class*="modal"]', root || document)
      .filter(isVisible)
      .sort(function (a, b) { return zIndex(a) - zIndex(b); });
  }

  function getFormScope() {
    var docs = getAccessibleDocuments();
    for (var d = 0; d < docs.length; d++) {
      var dialogs = getVisibleDialogs(docs[d]).filter(function (el) {
        return getNativeRadioGroups(el).length > 0 || getCustomRadioGroups(el).length > 0 || getTextareas(el).length > 0;
      });
      if (dialogs.length) return dialogs[dialogs.length - 1];
    }
    for (var f = 1; f < docs.length; f++) {
      if (getAllRadioGroups(docs[f]).length > 0 || getTextareas(docs[f]).length > 0) return docs[f];
    }
    return document;
  }

  // ---------------------------------------------------------------------------
  // 单选与文本域
  // ---------------------------------------------------------------------------

  function getRadioLabelElement(radio) {
    var label = null;
    try { label = radio.closest('label'); } catch (e) { /* ignore */ }
    if (!label && radio.id) {
      var doc = radio.ownerDocument || document;
      try { label = doc.querySelector('label[for="' + CSS.escape(radio.id) + '"]'); } catch (e) { /* ignore */ }
    }
    if (!label) {
      var parent = radio.parentElement;
      if (parent) label = parent.querySelector('.bh-radio-label, [class*="radio-label"], [class*="radioLabel"]');
    }
    return label;
  }

  function getRadioLabel(radio) {
    return textOf(getRadioLabelElement(radio) || radio.parentElement || radio);
  }

  function getNativeRadioGroups(root) {
    var radios = $$('input[type="radio"]', root || document).filter(function (el) {
      if (el.disabled) return false;
      if (isVisible(el)) return true;
      var label = getRadioLabelElement(el);
      if (label && isVisible(label)) return true;
      var parent = el.parentElement;
      return !!(el.getAttribute('data-x-dasm') && parent && isVisible(parent));
    });
    var map = new Map();
    radios.forEach(function (radio, index) {
      var key = radio.name || radio.getAttribute('name');
      if (!key) {
        var container = radio.closest('[role="radiogroup"], fieldset, [class*="question"], [class*="item"], [class*="group"]') || radio.parentElement;
        key = 'group-' + index + '-' + (container ? container.className : '');
      }
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(radio);
    });
    return Array.from(map.values()).filter(function (group) { return group.length > 0; });
  }

  function getCustomRadioGroups(root) {
    var nodes = $$('[role="radio"], .bh-radio-item, [class*="radio-item"], [class*="radioItem"], [class*="radio-box"], [class*="radioBox"]', root || document)
      .filter(function (el) {
        if (!isVisible(el) || el.disabled) return false;
        if (el.querySelector('input[type="radio"]')) return false;
        return true;
      });
    var map = new Map();
    nodes.forEach(function (el) {
      var key = el.parentElement || el;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(el);
    });
    return Array.from(map.values()).filter(function (group) { return group.length >= 2; });
  }

  function getAllRadioGroups(root) {
    return getNativeRadioGroups(root).concat(getCustomRadioGroups(root));
  }

  function wantedOptions() {
    return [state.settings.optionText].concat(state.settings.fallbackOptions || []).map(normalize).filter(Boolean);
  }

  function radioOptionText(radio) {
    var attr = normalize(radio.getAttribute('data-x-dasm') || '');
    if (attr) return attr;
    var aria = normalize(radio.getAttribute('aria-label') || radio.getAttribute('title') || '');
    if (aria) return aria;
    return normalize(getRadioLabel(radio));
  }

  function pickNativeRadio(group) {
    var wanted = wantedOptions();
    var matched = group.find(function (radio) {
      var text = radioOptionText(radio);
      return wanted.some(function (option) { return text.indexOf(option) !== -1; });
    });
    return matched || group[group.length - 1] || group[0];
  }

  function clickNativeRadio(radio) {
    if (radio.checked) return true;
    var label = getRadioLabelElement(radio);
    var target = (isVisible(radio) ? radio : (label || radio));
    try { target.click(); } catch (err) { try { radio.click(); } catch (e2) { /* ignore */ } }
    if (!radio.checked) {
      try { radio.click(); } catch (e2) { /* ignore */ }
    }
    if (!radio.checked) {
      try {
        radio.checked = true;
        radio.dispatchEvent(new Event('input', { bubbles: true }));
        radio.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e3) { /* ignore */ }
    }
    return radio.checked || radio.getAttribute('aria-checked') === 'true';
  }

  function customRadioText(el) {
    return textOf(el) || el.getAttribute('aria-label') || el.getAttribute('title') || '';
  }

  function pickCustomRadio(group) {
    var wanted = wantedOptions();
    var matched = group.find(function (el) {
      var text = normalize(customRadioText(el));
      return wanted.some(function (option) { return text.indexOf(option) !== -1; });
    });
    return matched || group[group.length - 1] || group[0];
  }

  function isCustomChecked(el) {
    var cls = String(el.className || '');
    return el.getAttribute('aria-checked') === 'true' ||
      el.getAttribute('aria-selected') === 'true' ||
      /(^|[\s_-])(active|checked|selected)([\s_-]|$)/i.test(cls);
  }

  function clickCustomRadio(el) {
    if (isCustomChecked(el)) return true;
    try { el.click(); } catch (err) { /* ignore */ }
    if (!isCustomChecked(el)) {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
    return isCustomChecked(el);
  }

  function getTextareas(root) {
    var areas = $$('textarea', root || document).filter(function (el) {
      return isVisible(el) && !el.disabled && !el.readOnly;
    });
    var editables = $$('[contenteditable="true"]', root || document).filter(function (el) {
      return isVisible(el) && el.getAttribute('aria-disabled') !== 'true';
    });
    return areas.concat(editables);
  }

  function readAreaValue(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA') return el.value || '';
    return el.textContent || '';
  }

  function setAreaValue(el, value) {
    if (el.tagName === 'TEXTAREA') {
      var proto = Object.getPrototypeOf(el);
      var descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = value;
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      } catch (err) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }

  function pickComment() {
    var pool = (state.settings.comments || []).filter(function (item) { return String(item).trim(); });
    if (!pool.length) return '无意见。';
    if (pool.length === 1) {
      state.lastComment = pool[0];
      return pool[0];
    }
    var comment = pool[Math.floor(Math.random() * pool.length)];
    if (comment === state.lastComment) {
      comment = pool[(pool.indexOf(comment) + 1) % pool.length];
    }
    state.lastComment = comment;
    return comment;
  }

  // ---------------------------------------------------------------------------
  // 填写 / 提交
  // ---------------------------------------------------------------------------

  async function fillCurrentForm() {
    var scope = getFormScope();
    var nativeGroups = getNativeRadioGroups(scope);
    var customGroups = getCustomRadioGroups(scope);
    var areas = getTextareas(scope);

    if (!nativeGroups.length && !customGroups.length && !areas.length) {
      throw new Error('未找到可填写的表单项；请先打开一份评教问卷');
    }

    if (state.stopRequested) {
      log('已停止填写', 'warn');
      return {
        stopped: true,
        nativeGroups: nativeGroups.length,
        filledNative: 0,
        customGroups: customGroups.length,
        filledCustom: 0,
        areas: areas.length,
        filledAreas: 0,
        errors: ['用户停止']
      };
    }

    var result = {
      nativeGroups: nativeGroups.length,
      filledNative: 0,
      customGroups: customGroups.length,
      filledCustom: 0,
      areas: areas.length,
      filledAreas: 0,
      errors: []
    };

    var interval = Math.max(0, Number(state.settings.intervalMs) || 0);

    for (var i = 0; i < nativeGroups.length; i++) {
      if (state.stopRequested) { result.errors.push('用户停止'); break; }
      var group = nativeGroups[i];
      if (!state.settings.overwriteChecked && group.some(function (r) { return r.checked; })) continue;
      var radio = pickNativeRadio(group);
      if (!radio) {
        result.errors.push('第 ' + (i + 1) + ' 组没有可用选项');
        continue;
      }
      if (clickNativeRadio(radio)) result.filledNative++;
      else result.errors.push('第 ' + (i + 1) + ' 组点击失败');
      if (interval) await sleep(interval);
    }

    for (var j = 0; j < customGroups.length; j++) {
      if (state.stopRequested) { result.errors.push('用户停止'); break; }
      var customGroup = customGroups[j];
      if (!state.settings.overwriteChecked && customGroup.some(isCustomChecked)) continue;
      var custom = pickCustomRadio(customGroup);
      if (!custom) {
        result.errors.push('自定义单选第 ' + (j + 1) + ' 组没有可用选项');
        continue;
      }
      if (clickCustomRadio(custom)) result.filledCustom++;
      else result.errors.push('自定义单选第 ' + (j + 1) + ' 组点击失败');
      if (interval) await sleep(interval);
    }

    for (var k = 0; k < areas.length; k++) {
      if (state.stopRequested) { result.errors.push('用户停止'); break; }
      var area = areas[k];
      if (state.settings.fillEmptyOnly && readAreaValue(area).trim()) continue;
      setAreaValue(area, pickComment());
      result.filledAreas++;
      if (interval) await sleep(interval);
    }

    if (state.stopRequested) {
      log('已停止填写：单选 ' + (result.filledNative + result.filledCustom) + ' 组，文本 ' + result.filledAreas + ' 个', 'warn');
      return Object.assign(result, { stopped: true });
    }

    var message = '已填：单选 ' + (result.filledNative + result.filledCustom) + ' 组，文本 ' + result.filledAreas + ' 个';
    if (result.errors.length) message += '；异常：' + result.errors.join('、');
    log(message, result.errors.length ? 'warn' : 'success');
    return result;
  }

  function getSubmitButton(root) {
    var scope = root || document;
    var candidates = $$('button, a, [role="button"], input[type="button"], input[type="submit"]', scope).filter(function (el) {
      return isVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    });
    function label(el) {
      return normalize(textOf(el) || el.value || el.getAttribute('data-action') || '');
    }
    return candidates.find(function (el) { return label(el) === '提交'; }) ||
      candidates.find(function (el) {
        var text = label(el);
        return text.indexOf('提交') !== -1 && text.indexOf('取消') === -1 && text.indexOf('返回') === -1;
      }) || null;
  }

  function findConfirmButton(exclude) {
    var dialogs = [];
    getAccessibleDocuments().forEach(function (doc) {
      getVisibleDialogs(doc).forEach(function (dialog) { dialogs.push(dialog); });
    });
    var matches = [];
    dialogs.forEach(function (dialog, dialogIndex) {
      $$('button, a, [role="button"]', dialog).forEach(function (el, index) {
        if (el === exclude || !isVisible(el) || el.disabled) return;
        var text = normalize(textOf(el) || el.value);
        if (/^(确定|确认|提交|是|继续)$/.test(text) || /确认提交|确定提交/.test(text)) {
          matches.push({ el: el, z: zIndex(dialog), dialogIndex: dialogIndex, index: index });
        }
      });
    });
    matches.sort(function (a, b) {
      if (a.z !== b.z) return a.z - b.z;
      if (a.dialogIndex !== b.dialogIndex) return a.dialogIndex - b.dialogIndex;
      return a.index - b.index;
    });
    return matches.length ? matches[matches.length - 1].el : null;
  }

  function findLooseConfirmButton(exclude) {
    var candidates = $$('button, a, [role="button"], input[type="button"], input[type="submit"]').filter(function (el) {
      if (el === exclude || !isVisible(el) || el.disabled) return false;
      var text = normalize(textOf(el) || el.value);
      return /^(确定|确认|是|确认提交|确定提交)$/.test(text);
    });
    return candidates.length ? candidates[candidates.length - 1] : null;
  }

  async function submitCurrentForm() {
    var scope = getFormScope();
    var button = getSubmitButton(scope) || getSubmitButton(document);
    if (!button) throw new Error('未找到提交按钮；可能已经提交，或页面结构已变化');

    var auto = !!state.autoSubmitting || !state.settings.confirmEach;
    if (!auto && state.settings.confirmEach && !window.confirm('确认提交当前问卷？')) {
      log('已取消提交', 'warn');
      return { cancelled: true };
    }

    var originalConfirm = window.confirm;
    var overridden = false;
    if (auto) {
      window.confirm = function () { return true; };
      overridden = true;
    }

    try {
      button.click();
      log('已点击提交按钮', 'info');
      var confirmButton = await waitFor(function () { return findConfirmButton(button); }, 4000).catch(function () { return null; });
      if (!confirmButton) confirmButton = findLooseConfirmButton(button);
      if (confirmButton) {
        confirmButton.click();
        log('已点击确认弹窗', 'info');
      }
      await waitFor(function () {
        if (/提交成功|保存成功|评价成功/.test(pageText())) return true;
        var current = getFormScope();
        if (current === document) {
          return getNativeRadioGroups(current).length === 0 &&
            getCustomRadioGroups(current).length === 0 &&
            getTextareas(current).length === 0;
        }
        return getNativeRadioGroups(current).length === 0 &&
          getCustomRadioGroups(current).length === 0 &&
          getTextareas(current).length === 0;
      }, 15000);
      log('提交后已确认表单关闭', 'success');
      return { submitted: true };
    } finally {
      if (overridden) window.confirm = originalConfirm;
    }
  }

  // ---------------------------------------------------------------------------
  // 批量处理
  // ---------------------------------------------------------------------------

  function findTextNodesWith(needle, root) {
    var container = root || document.body;
    if (!container) return [];
    var result = [];
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || node.nodeValue.indexOf(needle) === -1) return NodeFilter.FILTER_REJECT;
        var parent = node.parentElement;
        if (!parent || !isVisible(parent)) return NodeFilter.FILTER_REJECT;
        if (parent.closest('#nwafu-eval-host, [data-nwafu-eval-ignore]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node = walker.nextNode();
    while (node) {
      result.push(node.parentElement);
      node = walker.nextNode();
    }
    return result;
  }

  function clickableAncestor(el) {
    var structural = 'a, button, [role="button"], .bh-card, [class*="card"], [class*="item"], li, tr';
    var current = el;
    for (var i = 0; i < 8 && current; i++, current = current.parentElement) {
      if (current.matches(structural)) return current;
    }
    current = el;
    for (var j = 0; j < 8 && current; j++, current = current.parentElement) {
      var view = (current.ownerDocument && current.ownerDocument.defaultView) || window;
      if (view.getComputedStyle(current).cursor === 'pointer') return current;
    }
    return el;
  }

  function getPendingCandidates() {
    if (!document.body) return [];
    var cards = $$('.bh-card.bh-card-lv1[data-action="查询问卷详情"]');
    if (!cards.length) cards = $$('.bh-card.bh-card-lv1');
    var direct = cards.filter(function (el) {
      if (!isVisible(el)) return false;
      var sfpg = el.getAttribute('data-x-sfpg');
      if (sfpg === '0') return true;
      return /未提交/.test(textOf(el));
    });
    if (direct.length) return direct;
    if (!/未提交/.test(pageText())) return [];
    var nodes = findTextNodesWith('未提交', document.body);
    var seen = [];
    var items = [];
    nodes.forEach(function (node) {
      var item = clickableAncestor(node);
      if (!item || !item.isConnected) return;
      if (seen.indexOf(item) !== -1) return;
      seen.push(item);
      items.push(item);
    });
    return items;
  }

  function itemKey(el) {
    var card = el && el.closest ? (el.closest('[data-x-jxbid], [data-x-wjdm]') || el) : el;
    if (card && card.getAttribute) {
      var id = (card.getAttribute('data-x-jxbid') || '') + '|' + (card.getAttribute('data-x-wjdm') || '');
      if (id !== '|') return id;
    }
    return textOf(el).replace(/未提交|已提交/g, '').replace(/\s+/g, '').slice(0, 200);
  }

  async function openPendingItem(item) {
    try { item.scrollIntoView({ block: 'center' }); } catch (err) { /* ignore */ }
    await sleep(200);
    var target = item.matches('a, button, [role="button"]')
      ? item
      : (item.querySelector('a, button, [role="button"]') || item);
    try { target.click(); } catch (err) {
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
    await waitFor(function () {
      var scope = getFormScope();
      return getAllRadioGroups(scope).length > 0 || getTextareas(scope).length > 0;
    }, 15000);
  }

  function getPendingCount() {
    return getPendingCandidates().length;
  }

  async function openFirstPending() {
    var items = getPendingCandidates();
    if (!items.length) {
      log('当前没有未提交项', 'warn');
      return;
    }
    var item = items[0];
    await openPendingItem(item);
    log('已打开：' + textOf(item).slice(0, 80), 'success');
    await sleep(500);
    refreshPanel();
  }

  async function openFirstPendingAndCheck() {
    if (state.running) return;
    var items = getPendingCandidates();
    if (!items.length) {
      log('当前没有未提交项', 'warn');
      return;
    }
    state.running = true;
    updateButtons();
    var item = items[0];
    try {
      try { item.scrollIntoView({ block: 'center' }); } catch (err) { /* ignore */ }
      await sleep(200);
      try { item.click(); } catch (err) {
        item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }
      log('已点击第一份，等待 3 秒后抓取页面结构…', 'info');
      await sleep(3000);
      if (state.stopRequested) {
        log('已停止自检', 'warn');
        return;
      }
      selfCheck();
      log('如果打开了新标签页，请在新标签页里按 Alt+Shift+P 再点自检', 'warn');
    } catch (err) {
      log('打开第一份失败：' + (err && err.message ? err.message : err), 'error');
    } finally {
      state.running = false;
      state.stopRequested = false;
      updateButtons();
      refreshPanel();
    }
  }

  async function runBatch(autoSubmit) {
    if (state.running) {
      log('已有任务在运行', 'warn');
      return;
    }
    var initial = getPendingCandidates();
    if (!initial.length) {
      log('未识别到未提交项。请确认当前在评教列表页；如果列表结构变了，请点“自检 / 复制结构”。', 'warn');
      return;
    }

    state.running = true;
    state.autoSubmitting = !!autoSubmit;
    state.stopRequested = false;
    state.processed = new Set();
    updateButtons();
    log('开始批量' + (autoSubmit ? '（全自动：打开并提交）' : '（半自动：只填，手动提交）') + '，共识别到 ' + initial.length + ' 项', 'info');

    var completed = 0;
    var failed = 0;

    try {
      for (var i = 0; i < (Number(state.settings.maxCount) || 50); i++) {
        if (state.stopRequested) {
          log('已停止批量', 'warn');
          break;
        }

        var pending = getPendingCandidates().filter(function (el) {
          return !state.processed.has(itemKey(el));
        });
        if (!pending.length) {
          log('没有更多未提交项', 'success');
          break;
        }

        var item = pending[0];
        var key = itemKey(item);
        state.currentItem = item;
        log('打开：' + textOf(item).slice(0, 80), 'info');

        try {
          await openPendingItem(item);
          var fillResult = await fillCurrentForm();
          if (state.stopRequested || (fillResult && fillResult.stopped)) {
            log('已停止，当前问卷不提交', 'warn');
            break;
          }

          if (autoSubmit) {
            var submitResult = await submitCurrentForm();
            if (submitResult && submitResult.cancelled) {
              state.processed.add(key);
              failed++;
              log('提交被取消，批量停止', 'warn');
              break;
            }
            await waitFor(function () {
              var s = getFormScope();
              return getAllRadioGroups(s).length === 0 && getTextareas(s).length === 0;
            }, 8000, 300).catch(async function () {
              var s = getFormScope();
              var root = s === document ? document : s;
              var close = root.querySelector('.bh-paper-pile-closeIcon');
              if (close && isVisible(close)) {
                close.click();
                log('提交后表单未关闭，已点击关闭图标', 'warn');
                await sleep(800);
              }
            });
            var openScope = getFormScope();
            if (getAllRadioGroups(openScope).length > 0 || getTextareas(openScope).length > 0) {
              failed++;
              log('提交后表单仍未关闭，批量停止', 'error');
              break;
            }
            await waitFor(function () {
              if (state.stopRequested) return true;
              return getPageKind() === 'list' || getPendingCandidates().length > 0;
            }, 15000, 300).catch(function () { /* 列表刷新慢时继续下一轮判断 */ });
          } else {
            log('已填写，请手动提交；提交/关闭问卷后会自动继续下一份', 'info');
            await waitFor(function () {
              if (state.stopRequested) return true;
              var scope = getFormScope();
              var formOpen = getAllRadioGroups(scope).length > 0 || getTextareas(scope).length > 0;
              if (formOpen) return false;
              var stillPending = getPendingCandidates().some(function (el) { return itemKey(el) === key; });
              return !stillPending || /提交成功|已提交/.test(pageText());
            }, 300000, 1000);
          }

          state.processed.add(key);
          completed++;
          saveHistoryEntry({
            time: new Date().toISOString(),
            url: location.href,
            course: textOf(item).replace(/未提交|已提交/g, '').trim().slice(0, 160),
            status: autoSubmit ? 'submitted' : 'filled',
            comment: state.lastComment,
            result: fillResult
          });

          await sleep(Math.max(300, Number(state.settings.intervalMs) || 0));
        } catch (err) {
          failed++;
          log('处理失败：' + (err && err.message ? err.message : err), 'error');
          break;
        }
      }
    } finally {
      state.running = false;
      state.autoSubmitting = false;
      state.currentItem = null;
      updateButtons();
      refreshPanel();
      log('批量结束：完成 ' + completed + '，失败 ' + failed, failed ? 'warn' : 'success');
      if (completed > 0 && !failed) {
        try {
          if (window.Notification && Notification.permission === 'granted') {
            new Notification('NWAFU 评教辅助', { body: '批量完成：' + completed + ' 份' });
          }
        } catch (err) { /* ignore */ }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 自检 / 记录
  // ---------------------------------------------------------------------------

  function safeOuterHTML(el, limit) {
    try { return String(el.outerHTML || '').slice(0, limit || 600); } catch (err) { return ''; }
  }

  function getInputLabel(el) {
    var label = null;
    try { label = el.closest('label'); } catch (e) { /* ignore */ }
    if (!label && el.id) {
      var doc = el.ownerDocument || document;
      try { label = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]'); } catch (e) { /* ignore */ }
    }
    return textOf(label || el.parentElement || el);
  }

  function getFormHtmlSnippet() {
    var scope = getFormScope();
    if (scope && scope !== document) {
      return safeOuterHTML(scope.body || scope, 16000);
    }
    var hasFormControl = $$('input[type="radio"], textarea, [contenteditable="true"]', document).some(isVisible);
    if (!hasFormControl) return '';
    var marker = $$('input[type="radio"], textarea, [contenteditable="true"], .bh-radio, .bh-paper-pile-body, .wjzb-card', document).find(isVisible);
    var container = marker;
    for (var i = 0; i < 6 && container && container.parentElement; i++) {
      container = container.parentElement;
      if (container.matches('form, .bh-paper-pile-body, .bh-paper-pile-dialog, [class*="wj"], [class*="form"], main')) break;
    }
    return safeOuterHTML(container || document.body, 16000);
  }

  function collectIframes() {
    return $$('iframe').slice(0, 20).map(function (frame) {
      var info = {
        src: frame.src || '',
        id: frame.id || '',
        className: typeof frame.className === 'string' ? frame.className : '',
        visible: isVisible(frame),
        accessible: false
      };
      try {
        var doc = frame.contentDocument;
        if (doc && doc.body) {
          info.accessible = true;
          info.url = doc.URL || '';
          info.text = textOf(doc.body).slice(0, 500);
          info.radioCount = $$('input[type="radio"]', doc).length;
          info.textareaCount = $$('textarea', doc).length;
          info.dialogCount = $$('[role="dialog"], [class*="dialog"], [class*="modal"]', doc).filter(isVisible).length;
        }
      } catch (err) {
        info.error = String(err && err.message ? err.message : err);
      }
      return info;
    });
  }

  function collectInputs(root, onlyRadio) {
    var selector = onlyRadio ? 'input[type="radio"]' : 'input';
    return $$(selector, root || document).slice(0, 120).map(function (el) {
      var attrs = [];
      for (var i = 0; i < el.attributes.length; i++) {
        var attr = el.attributes[i];
        if (attr.name.indexOf('data-x-') === 0) attrs.push(attr.name + '=' + attr.value);
      }
      return {
        type: el.type,
        name: el.name || '',
        id: el.id || '',
        className: typeof el.className === 'string' ? el.className : '',
        value: el.value,
        checked: !!el.checked,
        disabled: !!el.disabled,
        visible: isVisible(el),
        label: getInputLabel(el).slice(0, 80),
        data: attrs.join(' '),
        html: safeOuterHTML(el, 260)
      };
    });
  }

  function collectRadioCandidates(root) {
    var selector = '[role="radio"], [role="radiogroup"], .bh-radio, .bh-radio-item, [class*="radio-item"], [class*="radioItem"], [class*="radio-box"], [class*="radioBox"], [class*="option"], [class*="score"], [class*="star"]';
    return $$(selector, root || document)
      .filter(function (el) {
        return el.tagName !== 'INPUT' && el.tagName !== 'OPTION' && textOf(el).length < 240;
      })
      .slice(0, 60).map(function (el) {
        return {
          tag: el.tagName,
          className: typeof el.className === 'string' ? el.className : '',
          role: el.getAttribute('role') || '',
          text: textOf(el).slice(0, 100),
          checked: isCustomChecked(el),
          visible: isVisible(el),
          html: safeOuterHTML(el, 300)
        };
      });
  }

  function collectTextareas(root) {
    return $$('textarea, [contenteditable="true"]', root || document).slice(0, 30).map(function (el) {
      return {
        tag: el.tagName,
        name: el.name || '',
        id: el.id || '',
        className: typeof el.className === 'string' ? el.className : '',
        placeholder: el.getAttribute('placeholder') || '',
        value: readAreaValue(el).slice(0, 100),
        disabled: !!el.disabled,
        readOnly: !!el.readOnly,
        visible: isVisible(el),
        html: safeOuterHTML(el, 300)
      };
    });
  }

  function selfCheck() {
    var scope = getFormScope();
    var data = {
      version: VERSION,
      time: new Date().toISOString(),
      url: location.href,
      title: document.title,
      pageKind: getPageKind(),
      formScope: scope === document ? 'document' : (scope.URL ? 'iframe:' + scope.URL : 'element'),
      hints: {
        hasPingjiao: /评教/.test(pageText()),
        hasPending: /未提交/.test(pageText()),
        hasSubmitted: /已提交/.test(pageText())
      },
      documents: getAccessibleDocuments().map(function (doc, index) {
        return { index: index, url: doc.URL || '', title: doc.title || '' };
      }),
      iframes: collectIframes(),
      pending: getPendingCandidates().slice(0, 10).map(function (el) {
        return {
          tag: el.tagName,
          className: typeof el.className === 'string' ? el.className : '',
          text: textOf(el).slice(0, 160),
          data: ['data-x-jxbid', 'data-x-wjdm', 'data-x-sfpg', 'data-action'].map(function (name) {
            return name + '=' + (el.getAttribute(name) || '');
          }).join(' '),
          html: safeOuterHTML(el, 700)
        };
      }),
      nativeRadioGroups: getNativeRadioGroups(scope).slice(0, 20).map(function (group) {
        return group.map(function (radio) {
          return {
            name: radio.name,
            id: radio.id,
            label: getRadioLabel(radio).slice(0, 80),
            checked: radio.checked,
            visible: isVisible(radio)
          };
        });
      }),
      customRadios: $$('[role="radio"], [class*="radio-item"], [class*="radioItem"]', scope)
        .filter(isVisible).slice(0, 30).map(function (el) {
          return {
            tag: el.tagName,
            className: typeof el.className === 'string' ? el.className : '',
            text: customRadioText(el).slice(0, 80),
            checked: isCustomChecked(el),
            html: safeOuterHTML(el, 300)
          };
        }),
      textareas: getTextareas(scope).slice(0, 10).map(function (el) {
        return {
          tag: el.tagName,
          name: el.name || '',
          id: el.id || '',
          placeholder: el.getAttribute('placeholder') || '',
          value: readAreaValue(el).slice(0, 80),
          html: safeOuterHTML(el, 300)
        };
      }),
      allInputs: collectInputs(scope, false),
      allRadios: collectInputs(scope, true),
      allTextareas: collectTextareas(scope),
      radioCandidates: collectRadioCandidates(scope),
      buttons: $$('button, a, [role="button"], input[type="button"], input[type="submit"]', scope)
        .filter(isVisible).slice(0, 60).map(function (el) {
          return {
            text: textOf(el).slice(0, 60),
            tag: el.tagName,
            className: typeof el.className === 'string' ? el.className : '',
            action: el.getAttribute('data-action') || ''
          };
        }),
      dialogs: getAccessibleDocuments().reduce(function (acc, doc) {
        return acc.concat(getVisibleDialogs(doc));
      }, []).slice(0, 10).map(function (el) {
        return {
          tag: el.tagName,
          className: typeof el.className === 'string' ? el.className : '',
          role: el.getAttribute('role') || '',
          text: textOf(el).slice(0, 300)
        };
      }),
      formHtml: getFormHtmlSnippet(),
      bodyText: pageText().slice(0, 2000)
    };

    state.lastSelfCheck = data;
    renderSelfCheck(data);
    log('自检结果已生成，点“复制”后可以发给维护者适配页面', 'success');
    return data;
  }

  function renderSelfCheck(data) {
    if (!state.panel) return;
    var panel = state.panel.root.querySelector('[data-role="check-panel"]');
    var textarea = state.panel.root.querySelector('[data-role="check-text"]');
    if (!panel || !textarea) return;
    panel.hidden = false;
    textarea.value = JSON.stringify(data, null, 2);
    textarea.focus();
    textarea.select();
  }

  function copySelfCheck() {
    if (!state.panel) return;
    var textarea = state.panel.root.querySelector('[data-role="check-text"]');
    if (!textarea || !textarea.value) {
      log('还没有自检结果，先点“自检 / 复制结构”', 'warn');
      return;
    }
    var finish = function () { log('自检结果已复制', 'success'); };
    var fail = function () {
      try {
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        finish();
      } catch (err) {
        log('复制失败，请手动全选文本框复制', 'warn');
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(textarea.value).then(finish).catch(fail);
    } else {
      fail();
    }
  }

  function exportHistory() {
    var history = loadHistory();
    if (!history.length) {
      log('还没有历史记录', 'warn');
      return;
    }
    var blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'nwafu-eval-history.json';
    link.style.display = 'none';
    document.documentElement.appendChild(link);
    link.click();
    setTimeout(function () {
      link.remove();
      URL.revokeObjectURL(url);
    }, 1000);
    log('已导出 ' + history.length + ' 条记录', 'success');
  }

  function clearHistory() {
    if (!window.confirm('确定清空本地评教记录？')) return;
    try { localStorage.removeItem(KEYS.history); } catch (err) { /* ignore */ }
    log('已清空本地记录', 'success');
  }

  // ---------------------------------------------------------------------------
  // 面板
  // ---------------------------------------------------------------------------

  var PANEL_CSS = [
    ':host { all: initial; }',
    '* { box-sizing: border-box; }',
    '.panel {',
    '  position: fixed; right: 16px; bottom: 16px; width: 360px; max-height: 78vh;',
    '  display: flex; flex-direction: column; pointer-events: auto;',
    '  color: #1f2933; background: #ffffff; border: 1px solid #c9d4e0; border-radius: 10px;',
    '  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.22); overflow: hidden;',
    '  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;',
    '  z-index: 2147483647;',
    '}',
    '.head { display: flex; align-items: center; justify-content: space-between; gap: 8px;',
    '  padding: 9px 10px; background: #f4f7fa; border-bottom: 1px solid #dbe3ec; cursor: move; user-select: none; }',
    '.title { font-weight: 700; font-size: 13px; }',
    '.ver { color: #8291a3; font-weight: 400; font-size: 11px; margin-left: 4px; }',
    '.icon-btn { width: 26px; height: 26px; padding: 0; border: 1px solid #c6d0dc; border-radius: 6px;',
    '  background: #fff; color: #334e68; cursor: pointer; font-size: 15px; line-height: 1; }',
    '.body { padding: 10px; overflow-y: auto; }',
    '.panel[data-collapsed="true"] .body { display: none; }',
    '.status { margin: 0 0 6px; padding: 7px 8px; border-radius: 6px; background: #eef3f8; color: #334e68; }',
    '.status[data-type="warn"] { background: #fff7e6; color: #8a5b00; }',
    '.status[data-type="error"] { background: #fff0f0; color: #a12626; }',
    '.counts { margin: 0 0 8px; color: #52667a; font-size: 12px; }',
    '.actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-bottom: 7px; }',
    '.actions.one { grid-template-columns: 1fr; }',
    '.actions button { min-height: 30px; padding: 5px 7px; border: 1px solid #c6d0dc; border-radius: 6px;',
    '  background: #fff; color: #24425c; cursor: pointer; font: inherit; }',
    '.actions button:hover:not(:disabled) { background: #f1f7ff; }',
    '.actions button:disabled { color: #9aa9b8; background: #f7f9fb; border-color: #e0e6ec; cursor: not-allowed; }',
    '.actions button.primary { border-color: #2f7de1; color: #1e5aa8; font-weight: 600; }',
    '.actions button.warn { border-color: #d97706; color: #8a5b00; }',
    '.actions button.danger { border-color: #d94b4b; color: #a12626; }',
    'details { margin: 8px 0; padding: 7px 8px; border: 1px solid #e0e6ec; border-radius: 6px; background: #fbfcfe; }',
    'summary { cursor: pointer; color: #334e68; font-weight: 600; }',
    'label { display: block; margin: 7px 0; color: #52667a; }',
    'label input[type="text"], label input[type="number"], label textarea { width: 100%; margin-top: 3px;',
    '  padding: 5px 6px; border: 1px solid #cfd8e3; border-radius: 5px; font: inherit; color: #1f2933; background: #fff; }',
    'label textarea { resize: vertical; }',
    '.check-panel { margin-top: 8px; }',
    '.check-panel textarea { width: 100%; height: 150px; padding: 6px; border: 1px solid #cfd8e3;',
    '  border-radius: 5px; font: 11px/1.4 Consolas, monospace; color: #1f2933; background: #fff; resize: vertical; }',
    '.log { max-height: 170px; overflow-y: auto; margin-top: 8px; padding: 6px 7px; border-radius: 6px;',
    '  background: #0f172a; color: #d6e2f0; font: 11px/1.45 Consolas, monospace; white-space: pre-wrap; word-break: break-word; }',
    '.log-line { margin: 1px 0; }',
    '.log-line[data-type="success"] { color: #86efac; }',
    '.log-line[data-type="warn"] { color: #fcd34d; }',
    '.log-line[data-type="error"] { color: #fca5a5; }',
    '.hint { margin-top: 6px; color: #8291a3; font-size: 11px; }'
  ].join('\n');

  var PANEL_HTML = [
    '<div class="panel" data-collapsed="false">',
    '  <div class="head" data-role="drag">',
    '    <div class="title">NWAFU 评教辅助 <span class="ver">v' + VERSION + '</span></div>',
    '    <button class="icon-btn" data-action="collapse" title="折叠/展开">−</button>',
    '  </div>',
    '  <div class="body">',
    '    <div class="status" data-role="status">正在检测页面…</div>',
    '    <div class="counts" data-role="counts"></div>',
    '    <div class="actions">',
    '      <button class="warn" data-action="submit">填写并提交当前问卷</button>',
    '      <button class="primary" data-action="batch-auto">全自动：打开并提交</button>',
    '    </div>',
    '    <div class="actions one">',
    '      <button class="danger" data-action="stop">停止</button>',
    '    </div>',
    '    <div class="actions">',
    '      <button data-action="check">自检 / 复制结构</button>',
    '      <button data-action="export">导出记录</button>',
    '      <button data-action="clear">清空记录</button>',
    '    </div>',
    '    <details data-role="settings">',
    '      <summary>设置</summary>',
    '      <label>选项文字<input data-setting="optionText" type="text"></label>',
    '      <label>选择题间隔 (ms)<input data-setting="intervalMs" type="number" min="0" step="50"></label>',
    '      <label>单次最多份数<input data-setting="maxCount" type="number" min="1" step="1"></label>',
    '      <label><input data-setting="confirmEach" type="checkbox"> 每次提交前确认（默认关闭，直接提交）</label>',
    '      <label><input data-setting="overwriteChecked" type="checkbox"> 覆盖已选答案</label>',
    '      <label>评语池（每行一条）<textarea data-setting="comments" rows="4"></textarea></label>',
    '      <button data-action="save-settings">保存设置</button>',
    '    </details>',
    '    <div class="check-panel" data-role="check-panel" hidden>',
    '      <textarea data-role="check-text" readonly placeholder="点“自检 / 复制结构”生成页面结构"></textarea>',
    '      <div class="actions">',
    '        <button data-action="copy-check">复制自检结果</button>',
    '        <button data-action="close-check">关闭</button>',
    '      </div>',
    '      <div class="hint">把复制内容发给维护者，用来适配新页面的选择器。</div>',
    '    </div>',
    '    <div class="log" data-role="log"></div>',
    '    <div class="hint">Alt + Shift + P 显示/隐藏面板；页面改版后先自检。</div>',
    '  </div>',
    '</div>'
  ].join('\n');

  function buildPanel() {
    var host = document.createElement('div');
    host.id = 'nwafu-eval-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    var shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>' + PANEL_CSS + '</style>' + PANEL_HTML;
    document.documentElement.appendChild(host);

    state.panel = {
      host: host,
      shadow: shadow,
      root: shadow.querySelector('.panel')
    };

    var root = state.panel.root;
    var collapsed = localStorage.getItem(KEYS.collapsed) === '1';
    root.dataset.collapsed = collapsed ? 'true' : 'false';
    root.querySelector('[data-action="collapse"]').textContent = collapsed ? '+' : '−';

    var position = null;
    try { position = JSON.parse(localStorage.getItem(KEYS.position) || 'null'); } catch (err) { /* ignore */ }
    if (position && typeof position.left === 'number' && typeof position.top === 'number') {
      root.style.left = position.left + 'px';
      root.style.top = position.top + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    }

    bindPanelEvents(shadow, root);
    syncSettingsUI();
    renderLog();
    updateVisibility();
  }

  function bindPanelEvents(shadow, root) {
    shadow.addEventListener('click', function (event) {
      var button = event.target.closest('[data-action]');
      if (!button) return;
      event.stopPropagation();
      handleAction(button.getAttribute('data-action'));
    });
    shadow.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
    shadow.addEventListener('mousedown', function (event) { event.stopPropagation(); });

    var dragHandle = root.querySelector('[data-role="drag"]');
    var dragging = false;
    var offsetX = 0;
    var offsetY = 0;
    dragHandle.addEventListener('pointerdown', function (event) {
      if (event.target.closest('button')) return;
      var rect = root.getBoundingClientRect();
      dragging = true;
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      root.style.left = rect.left + 'px';
      root.style.top = rect.top + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      try { dragHandle.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
      event.preventDefault();
    });
    dragHandle.addEventListener('pointermove', function (event) {
      if (!dragging) return;
      var left = Math.max(0, Math.min(window.innerWidth - 80, event.clientX - offsetX));
      var top = Math.max(0, Math.min(window.innerHeight - 40, event.clientY - offsetY));
      root.style.left = left + 'px';
      root.style.top = top + 'px';
    });
    dragHandle.addEventListener('pointerup', function () {
      if (!dragging) return;
      dragging = false;
      try {
        localStorage.setItem(KEYS.position, JSON.stringify({
          left: parseFloat(root.style.left) || 0,
          top: parseFloat(root.style.top) || 0
        }));
      } catch (err) { /* ignore */ }
    });
  }

  function toggleCollapse() {
    if (!state.panel) return;
    var root = state.panel.root;
    var collapsed = root.dataset.collapsed !== 'true';
    root.dataset.collapsed = collapsed ? 'true' : 'false';
    root.querySelector('[data-action="collapse"]').textContent = collapsed ? '+' : '−';
    try { localStorage.setItem(KEYS.collapsed, collapsed ? '1' : '0'); } catch (err) { /* ignore */ }
  }

  function syncSettingsUI() {
    if (!state.panel) return;
    var root = state.panel.root;
    var settings = state.settings;
    var option = root.querySelector('[data-setting="optionText"]');
    var interval = root.querySelector('[data-setting="intervalMs"]');
    var maxCount = root.querySelector('[data-setting="maxCount"]');
    var confirmEach = root.querySelector('[data-setting="confirmEach"]');
    var overwriteChecked = root.querySelector('[data-setting="overwriteChecked"]');
    var comments = root.querySelector('[data-setting="comments"]');
    if (option) option.value = settings.optionText;
    if (interval) interval.value = String(settings.intervalMs);
    if (maxCount) maxCount.value = String(settings.maxCount);
    if (confirmEach) confirmEach.checked = !!settings.confirmEach;
    if (overwriteChecked) overwriteChecked.checked = !!settings.overwriteChecked;
    if (comments) comments.value = (settings.comments || []).join('\n');
  }

  function saveSettingsFromUI() {
    if (!state.panel) return;
    var root = state.panel.root;
    var option = root.querySelector('[data-setting="optionText"]');
    var interval = root.querySelector('[data-setting="intervalMs"]');
    var maxCount = root.querySelector('[data-setting="maxCount"]');
    var confirmEach = root.querySelector('[data-setting="confirmEach"]');
    var overwriteChecked = root.querySelector('[data-setting="overwriteChecked"]');
    var comments = root.querySelector('[data-setting="comments"]');

    var next = Object.assign({}, state.settings);
    next.optionText = (option && option.value.trim()) || '完全赞同';
    next.intervalMs = Math.max(0, Number(interval && interval.value) || 0);
    next.maxCount = Math.max(1, Number(maxCount && maxCount.value) || 1);
    next.confirmEach = !!(confirmEach && confirmEach.checked);
    next.overwriteChecked = !!(overwriteChecked && overwriteChecked.checked);
    next.comments = (comments ? comments.value : '').split('\n').map(function (line) { return line.trim(); }).filter(Boolean);

    if (!next.comments.length) next.comments = DEFAULT_SETTINGS.comments.slice();

    state.settings = next;
    saveSettings();
    log('设置已保存', 'success');
  }

  function runSingleTask(name, task) {
    if (state.running) {
      log('正在运行，请先停止', 'warn');
      return;
    }
    state.running = true;
    state.autoSubmitting = false;
    state.stopRequested = false;
    updateButtons();
    Promise.resolve()
      .then(task)
      .catch(function (err) {
        log(name + '失败：' + (err && err.message ? err.message : err), 'error');
      })
      .finally(function () {
        state.running = false;
        state.stopRequested = false;
        updateButtons();
        refreshPanel();
      });
  }

  function handleAction(action) {
    if (!action) return;
    if (state.running && action !== 'stop' && action !== 'check' && action !== 'settings' &&
      action !== 'export' && action !== 'copy-check' && action !== 'close-check' && action !== 'collapse') {
      log('正在运行，请先停止', 'warn');
      return;
    }

    if (action === 'stop') {
      if (!state.running) {
        log('当前没有正在运行的任务', 'info');
        return;
      }
      state.stopRequested = true;
      log('已请求停止，当前步骤结束后停止', 'warn');
      return;
    }
    if (action === 'collapse') {
      toggleCollapse();
      return;
    }
    if (action === 'settings') {
      var details = state.panel && state.panel.root.querySelector('[data-role="settings"]');
      if (details) {
        details.open = true;
        details.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    if (action === 'check') {
      selfCheck();
      return;
    }
    if (action === 'copy-check') {
      copySelfCheck();
      return;
    }
    if (action === 'close-check') {
      var checkPanel = state.panel && state.panel.root.querySelector('[data-role="check-panel"]');
      if (checkPanel) checkPanel.hidden = true;
      return;
    }
    if (action === 'export') {
      exportHistory();
      return;
    }
    if (action === 'clear') {
      clearHistory();
      return;
    }
    if (action === 'save-settings') {
      saveSettingsFromUI();
      return;
    }
    if (action === 'open-first') {
      openFirstPending().catch(function (err) { log('打开失败：' + (err && err.message ? err.message : err), 'error'); });
      return;
    }
    if (action === 'open-first-check') {
      openFirstPendingAndCheck().catch(function (err) { log('自检失败：' + (err && err.message ? err.message : err), 'error'); });
      return;
    }
    if (action === 'fill') {
      runSingleTask('填写', fillCurrentForm);
      return;
    }
    if (action === 'submit') {
      runSingleTask('填写并提交', async function () {
        await fillCurrentForm();
        if (state.stopRequested) return;
        await submitCurrentForm();
      });
      return;
    }
    if (action === 'batch-fill') {
      runBatch(false).catch(function (err) { log('批量失败：' + (err && err.message ? err.message : err), 'error'); });
      return;
    }
    if (action === 'batch-auto') {
      runBatch(true).catch(function (err) { log('批量失败：' + (err && err.message ? err.message : err), 'error'); });
    }
  }

  function updateButtons() {
    if (!state.panel) return;
    var root = state.panel.root;
    var kind = getPageKind();
    var pending = kind === 'list' ? getPendingCount() : 0;
    var hasForm = kind === 'form';
    var hasList = kind === 'list';
    function set(name, disabled) {
      var button = root.querySelector('[data-action="' + name + '"]');
      if (button) button.disabled = !!disabled;
    }
    set('submit', state.running || !hasForm);
    set('batch-auto', state.running || !hasList || pending === 0);
    set('stop', false);
  }

  function renderLog() {
    if (!state.panel) return;
    var container = state.panel.root.querySelector('[data-role="log"]');
    if (!container) return;
    container.textContent = '';
    state.logLines.slice(-80).forEach(function (line) {
      var div = document.createElement('div');
      div.className = 'log-line';
      div.dataset.type = line.type;
      div.textContent = '[' + line.time + '] ' + line.message;
      container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
  }

  function refreshPanel() {
    if (!state.panel) return;
    var status = state.panel.root.querySelector('[data-role="status"]');
    var counts = state.panel.root.querySelector('[data-role="counts"]');
    if (!status || !counts) return;

    if (!hasEvaluationText()) {
      status.textContent = '非评教页面。' + (state.forceShow ? '已强制显示，可点自检查看结构。' : '按 Alt+Shift+P 可强制显示。');
      status.dataset.type = 'warn';
      counts.textContent = '';
      updateButtons();
      return;
    }

    var kind = getPageKind();
    var scope = getFormScope();
    var pending = kind === 'list' ? getPendingCount() : 0;
    var nativeGroups = getNativeRadioGroups(scope);
    var customGroups = getCustomRadioGroups(scope);
    var areas = getTextareas(scope);
    var submitButton = getSubmitButton(scope);
    var groupCount = nativeGroups.length + customGroups.length;
    var signature = [location.href, kind, pending, groupCount, areas.length, !!submitButton].join('|');
    if (signature === state.lastSignature) return;
    state.lastSignature = signature;

    if (kind === 'list') {
      status.textContent = pending
        ? '列表页：识别到 ' + pending + ' 个未提交项；点“全自动：打开并提交”'
        : '列表页：没有未提交项（可能已全部提交）';
      status.dataset.type = pending ? 'info' : 'success';
    } else if (kind === 'form') {
      status.textContent = '表单页：单选 ' + groupCount + ' 组，文本 ' + areas.length + ' 个' + (submitButton ? '；可提交' : '') + '。全自动请回列表页';
      status.dataset.type = 'info';
    } else {
      status.textContent = '未识别到评教列表或问卷';
      status.dataset.type = 'warn';
    }

    var parts = [];
    if (pending) parts.push('未提交 ' + pending);
    if (groupCount) parts.push('单选 ' + groupCount + ' 组（原生 ' + nativeGroups.length + ' / 自定义 ' + customGroups.length + '）');
    if (areas.length) parts.push('文本 ' + areas.length + ' 个');
    if (submitButton) parts.push('提交按钮：有');
    counts.textContent = parts.join(' · ') || '可以点“自检 / 复制结构”查看页面元素。';

    updateButtons();
  }

  function updateVisibility() {
    if (!state.panel) return;
    var detected = isEvaluationPage();
    var show = state.forceShow === true ? true : state.forceShow === false ? false : detected;
    state.panel.host.style.display = show ? 'block' : 'none';
    if (show) refreshPanel();
  }

  function scheduleRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(function () {
      if (!state.panel) return;
      if (!state.panel.host.isConnected) {
        document.documentElement.appendChild(state.panel.host);
      }
      updateVisibility();
      refreshPanel();
    }, 400);
  }

  // ---------------------------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------------------------

  function bindGlobalShortcut() {
    window.addEventListener('keydown', function (event) {
      if (event.altKey && event.shiftKey && (event.code === 'KeyP' || String(event.key).toLowerCase() === 'p')) {
        event.preventDefault();
        if (!state.panel) return;
        var visible = state.panel.host.style.display !== 'none';
        state.forceShow = visible ? false : true;
        updateVisibility();
        log(state.forceShow ? '面板已强制显示' : '面板已隐藏', 'info');
      }
    }, true);
  }

  function observePage() {
    window.addEventListener('hashchange', scheduleRefresh);
    window.addEventListener('popstate', scheduleRefresh);
    try {
      new MutationObserver(scheduleRefresh).observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    } catch (err) { /* ignore */ }
    setInterval(scheduleRefresh, 2000);
  }

  function exposeApi() {
    window.__NWAFU_EVAL__ = {
      version: VERSION,
      state: state,
      getPageKind: getPageKind,
      getPendingCandidates: getPendingCandidates,
      getPendingCount: getPendingCount,
      fillCurrentForm: fillCurrentForm,
      submitCurrentForm: submitCurrentForm,
      runBatch: runBatch,
      selfCheck: selfCheck,
      refreshPanel: refreshPanel,
      getSettings: function () { return Object.assign({}, state.settings); },
      setSettings: function (patch) {
        Object.assign(state.settings, patch || {});
        saveSettings();
        syncSettingsUI();
        refreshPanel();
      },
      get lastSelfCheck() { return state.lastSelfCheck; }
    };
  }

  function init() {
    if (!document.body) {
      setTimeout(init, 200);
      return;
    }
    buildPanel();
    bindGlobalShortcut();
    observePage();
    exposeApi();
    scheduleRefresh();
    log('v' + VERSION + ' 已加载；Alt+Shift+P 显示/隐藏面板', 'info');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
