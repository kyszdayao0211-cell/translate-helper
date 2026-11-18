#!/usr/bin/env node
'use strict';

/**
 * 术语表 JSON 格式转换工具
 * 把各种常见格式的术语表转换成翻译助手插件「从 JSON 导入（覆盖）」要求的标准格式：
 *   [{"source": "源文本", "target": "翻译", "notes": "备注"}, ...]
 *
 * 用法：
 *   node convert-glossary.js <输入文件.json> [输出文件.json]
 *
 * 自动识别的输入格式：
 *   1. 标准数组:       [{"source":"a","target":"b","notes":"c"}, ...]
 *   2. 对象包装:       {"terms": [...]} / {"data": [...]} / {"glossary": [...]} 等
 *   3. 中文/自定义字段: [{"原文":"a","译文":"b","备注":"c"}, ...]
 *   4. 二维数组:       [["source","target","notes"], ["a","b","c"], ...]
 *   5. JSON Lines:     每行一个 {"source":..} 对象
 */

const fs = require('fs');
const path = require('path');

// ---- 字段别名表（匹配时先归一化：转小写、去空格/下划线/连字符/点）----
const SOURCE_KEYS = ['source', 'src', 'sourcetext', '原文', '源文本', '源语言', '源文', 'term', '术语', 'key', 'korean', 'kr', 'ko', '韩文原文', '中文原文'];
const TARGET_KEYS = ['target', 'tgt', 'targettext', '译文', '翻译', '目标语言', '目标文本', '译法', 'translation', 'trans', 'value', 'val', '中文译文', '韩文译文'];
const NOTE_KEYS = ['notes', 'note', '备注', '说明', '注释', 'comment', 'comments', 'remarks', 'remark', 'description', 'desc', 'context', '上下文'];

function normalizeKey(k) {
  return String(k).trim().toLowerCase().replace(/[\s_\-.]+/g, '');
}

function pickField(obj, keys) {
  for (const k of Object.keys(obj)) {
    if (keys.includes(normalizeKey(k))) {
      const v = obj[k];
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        return { value: String(v).trim(), rawKey: k };
      }
    }
  }
  return { value: '', rawKey: '' };
}

// 从任意结构中提取术语数组
function extractTermArray(data) {
  if (Array.isArray(data)) return { arr: data, via: '顶层数组' };
  if (data && typeof data === 'object') {
    const candidates = ['terms', 'data', 'glossary', 'items', 'entries', 'list', 'terminology', '术语表', '术语', '术语库', 'termbase', 'records'];
    for (const key of Object.keys(data)) {
      if (candidates.includes(normalizeKey(key)) && Array.isArray(data[key])) {
        return { arr: data[key], via: `对象字段 "${key}"` };
      }
    }
    // 兜底 1：对象本身含 source/target 字段，视为单条术语
    if (pickField(data, SOURCE_KEYS).value && pickField(data, TARGET_KEYS).value) {
      return { arr: [data], via: '单条术语对象' };
    }
    // 兜底 2：对象的任意一个数组字段
    for (const key of Object.keys(data)) {
      if (Array.isArray(data[key]) && data[key].length > 0) return { arr: data[key], via: `对象字段 "${key}"` };
    }
  }
  return null;
}

// 把单条记录归一化为 {source, target, notes}
function normalizeEntry(entry) {
  if (Array.isArray(entry)) {
    return {
      source: String(entry[0] ?? '').trim(),
      target: String(entry[1] ?? '').trim(),
      notes: String(entry[2] ?? '').trim(),
      rawKeys: ['[0]', '[1]', '[2]'],
    };
  }
  if (entry && typeof entry === 'object') {
    const s = pickField(entry, SOURCE_KEYS);
    const t = pickField(entry, TARGET_KEYS);
    const n = pickField(entry, NOTE_KEYS);
    return { source: s.value, target: t.value, notes: n.value, rawKeys: [s.rawKey, t.rawKey, n.rawKey] };
  }
  return null;
}

// 判断二维数组第一行是否是表头
function looksLikeHeader(row) {
  if (!Array.isArray(row)) return false;
  const cells = row.map(c => normalizeKey(c));
  return cells.some(c => SOURCE_KEYS.includes(c)) || cells.some(c => TARGET_KEYS.includes(c));
}

function parseInput(text) {
  // 去掉 UTF-8 BOM
  const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;

  try {
    return { data: JSON.parse(clean), format: 'JSON' };
  } catch (e) { /* 继续尝试其他格式 */ }

  // 尝试 JSON Lines（每行一个 JSON 对象/数组）
  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    try {
      const parsed = lines.map(l => JSON.parse(l));
      return { data: parsed, format: 'JSON Lines（每行一个对象）' };
    } catch (e) { /* 放弃 */ }
  }

  return { data: null, format: null };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('用法: node convert-glossary.js <输入文件.json> [输出文件.json]');
    process.exit(1);
  }

  const inputPath = path.resolve(args[0]);
  const outputPath = path.resolve(args[1] || inputPath.replace(/\.json$/i, '') + '-标准格式.json');

  let text;
  try {
    text = fs.readFileSync(inputPath, 'utf8');
  } catch (e) {
    console.error('读取文件失败: ' + e.message);
    process.exit(1);
  }

  const { data: raw, format } = parseInput(text);
  if (raw === null) {
    console.error('无法解析文件：不是合法的 JSON，也不是 JSON Lines。');
    console.error('请用 VS Code 等编辑器打开文件，确认内容是标准 JSON 格式。');
    process.exit(1);
  }

  const extracted = extractTermArray(raw);
  if (!extracted) {
    console.error('无法找到术语数组：JSON 顶层必须是数组，或对象里包含 terms/data 等数组字段。');
    console.error('文件开头 200 字符: ' + JSON.stringify(raw).slice(0, 200));
    process.exit(1);
  }

  // 二维数组 + 表头：跳过第一行
  let entries = extracted.arr;
  let headerSkipped = false;
  if (entries.length > 0 && Array.isArray(entries[0]) && looksLikeHeader(entries[0])) {
    entries = entries.slice(1);
    headerSkipped = true;
  }

  const terms = [];
  let skipped = 0;
  let firstRawKeys = null;
  entries.forEach((entry) => {
    const t = normalizeEntry(entry);
    if (!t) { skipped++; return; }
    if (!firstRawKeys) firstRawKeys = t.rawKeys;
    if (!t.source || !t.target) { skipped++; return; }
    terms.push({ source: t.source, target: t.target, notes: t.notes });
  });

  if (terms.length === 0) {
    console.error('没有解析到有效术语（需要 source 和 target 都不为空）。');
    console.error('原始结构预览: ' + JSON.stringify(raw).slice(0, 300));
    process.exit(1);
  }

  fs.writeFileSync(outputPath, JSON.stringify(terms, null, 2), 'utf8');

  console.log('输入格式: ' + format + '（术语数组来自: ' + extracted.via + (headerSkipped ? '，已跳过表头行' : '') + '）');
  if (firstRawKeys) {
    console.log('字段映射: source <- "' + firstRawKeys[0] + '"  |  target <- "' + firstRawKeys[1] + '"  |  notes <- "' + (firstRawKeys[2] || '(无)') + '"');
  }
  console.log('共解析 ' + terms.length + ' 条术语' + (skipped > 0 ? '（跳过 ' + skipped + ' 条无效记录：缺少源文本或译文）' : ''));
  console.log('');
  console.log('前 3 条预览:');
  terms.slice(0, 3).forEach(t => console.log('  ' + t.source + '  ->  ' + t.target + (t.notes ? '  （' + t.notes + '）' : '')));
  console.log('');
  console.log('已写入: ' + outputPath);
  console.log('');
  console.log('下一步：插件里 工作面板 → 术语管理 → 文档术语库 (_glossary / _guide) → 从 JSON 导入（覆盖）');
  console.log('选择这个文件即可。注意：导入会覆盖 _glossary 标签页的全部内容，操作前建议先「导出 JSON」备份。');
}

main();
