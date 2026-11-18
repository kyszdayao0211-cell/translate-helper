// 术语表文件解析与生成：.json / .csv / .xlsx → 统一为 [{ source, target, notes }]
// xlsx 解析不依赖第三方库：xlsx 本质是 ZIP（解析思路与 docx.js 相同），
// 内容在 xl/sharedStrings.xml + xl/worksheets/sheet1.xml。
// 核心函数都是纯函数（吃 ArrayBuffer/字符串，吐数据），方便在 Node 里测试。

// ---------- 字段别名（匹配时归一化：小写、去空格/下划线/连字符） ----------

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

// ---------- ZIP 读取（xlsx 用） ----------

// 在中央目录里找指定文件，返回 { compMethod, compSize, localOffset }
function findZipEntry(bytes, dv, name) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const cdCount = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);

  const CDH_SIG = 0x02014b50;
  let ptr = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (ptr + 46 > bytes.length || dv.getUint32(ptr, true) !== CDH_SIG) break;
    const compMethod = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const localOffset = dv.getUint32(ptr + 42, true);
    const entryName = new TextDecoder().decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    if (entryName === name) return { compMethod, compSize, localOffset };
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// 解压并返回指定文件的内容
async function readZipEntry(arrayBuffer, bytes, dv, name) {
  const entry = findZipEntry(bytes, dv, name);
  if (!entry) return null;

  const LFH_SIG = 0x04034b50;
  const lo = entry.localOffset;
  if (lo + 30 > bytes.length || dv.getUint32(lo, true) !== LFH_SIG) {
    throw new Error('Excel 文件解析失败（ZIP 结构损坏）');
  }
  const lNameLen = dv.getUint16(lo + 26, true);
  const lExtraLen = dv.getUint16(lo + 28, true);
  const dataStart = lo + 30 + lNameLen + lExtraLen;
  const compData = bytes.subarray(dataStart, dataStart + entry.compSize);

  if (entry.compMethod === 0) return compData;
  if (entry.compMethod === 8) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([compData]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  throw new Error('不支持的 Excel 压缩格式');
}

// ---------- XML 工具 ----------

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&'); // & 放最后，避免二次转义
}

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------- xlsx 解析 ----------

// 解析 sharedStrings.xml → 字符串数组（兼容富文本多个 run 拼接）
function parseSharedStrings(xml) {
  const list = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1] || '';
    let out = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(inner)) !== null) out += tm[1];
    list.push(decodeXmlEntities(out));
  }
  return list;
}

// 列字母 → 0 基索引：A→0, B→1, ..., AA→26
function colLetterToIndex(letters) {
  let index = 0;
  for (let i = 0; i < letters.length; i++) {
    index = index * 26 + (letters.charCodeAt(i) - 64);
  }
  return index - 1;
}

// 解析 worksheet XML → 二维数组（按单元格 r="A1" 属性定位，正确处理空单元格）
function parseSheetXml(xml) {
  const rows = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[2])) !== null) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const refMatch = attrs.match(/\br="([A-Z]+)\d+"/);
      const colIdx = refMatch ? colLetterToIndex(refMatch[1]) : cells.length;
      const typeMatch = attrs.match(/\bt="([^"]+)"/);
      const type = typeMatch ? typeMatch[1] : 'n';

      let value = '';
      if (type === 's') {
        // 共享字符串索引，值由调用方回填
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = vMatch ? { __sharedIndex: parseInt(vMatch[1], 10) } : '';
      } else if (type === 'inlineStr') {
        const tMatch = inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
        value = tMatch ? decodeXmlEntities(tMatch[1]) : '';
      } else if (type === 'str') {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = vMatch ? decodeXmlEntities(vMatch[1]) : '';
      } else if (type === 'b') {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = vMatch && vMatch[1] === '1' ? 'TRUE' : 'FALSE';
      } else {
        // 数字 / 日期序列号等，取原文本
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = vMatch ? vMatch[1] : '';
      }
      cells[colIdx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

// ---------- 二维数组 → 术语 ----------

// 表头行匹配：返回 { srcIdx, tgtIdx, noteIdx } 或 null
function matchHeaderRow(row) {
  if (!Array.isArray(row)) return null;
  let srcIdx = -1;
  let tgtIdx = -1;
  let noteIdx = -1;
  for (let i = 0; i < row.length; i++) {
    const nk = normalizeKey(row[i] ?? '');
    if (!nk) continue;
    if (srcIdx < 0 && SOURCE_KEYS.includes(nk)) srcIdx = i;
    else if (tgtIdx < 0 && TARGET_KEYS.includes(nk)) tgtIdx = i;
    else if (noteIdx < 0 && NOTE_KEYS.includes(nk)) noteIdx = i;
  }
  if (srcIdx >= 0 && tgtIdx >= 0 && srcIdx !== tgtIdx) return { srcIdx, tgtIdx, noteIdx };
  return null;
}

// 把二维数组转成术语列表；无表头时按 A/B/C 顺序
function rowsToTerms(rows) {
  // 找到第一个非空行
  let start = 0;
  while (start < rows.length && (!rows[start] || rows[start].every(c => c === undefined || c === ''))) start++;
  if (start >= rows.length) return [];

  const header = matchHeaderRow(rows[start]);
  const { srcIdx, tgtIdx, noteIdx } = header || { srcIdx: 0, tgtIdx: 1, noteIdx: 2 };
  const dataStart = header ? start + 1 : start;

  const terms = [];
  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const source = String(row[srcIdx] ?? '').trim();
    const target = String(row[tgtIdx] ?? '').trim();
    if (!source || !target) continue;
    terms.push({
      source,
      target,
      notes: noteIdx >= 0 ? String(row[noteIdx] ?? '').trim() : '',
    });
  }
  return terms;
}

// ---------- CSV 解析 ----------

// 标准 CSV 状态机：支持引号包裹、" 转义、跨行引号字段、CRLF/LF
function parseCsv(text) {
  const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  // 收尾：最后一个字段/行（文件不以换行结尾时）
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------- JSON 解析（兼容各种民间格式） ----------

function extractTermArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const candidates = ['terms', 'data', 'glossary', 'items', 'entries', 'list', 'terminology', '术语表', '术语', '术语库', 'termbase', 'records'];
    for (const key of Object.keys(data)) {
      if (candidates.includes(normalizeKey(key)) && Array.isArray(data[key])) return data[key];
    }
    if (pickField(data, SOURCE_KEYS).value && pickField(data, TARGET_KEYS).value) return [data];
    for (const key of Object.keys(data)) {
      if (Array.isArray(data[key]) && data[key].length > 0) return data[key];
    }
  }
  return null;
}

function jsonEntriesToTerms(entries) {
  const terms = [];
  entries.forEach((entry) => {
    if (Array.isArray(entry)) {
      const source = String(entry[0] ?? '').trim();
      const target = String(entry[1] ?? '').trim();
      if (source && target) terms.push({ source, target, notes: String(entry[2] ?? '').trim() });
      return;
    }
    if (entry && typeof entry === 'object') {
      const s = pickField(entry, SOURCE_KEYS).value;
      const t = pickField(entry, TARGET_KEYS).value;
      const n = pickField(entry, NOTE_KEYS).value;
      if (s && t) terms.push({ source: s, target: t, notes: n });
    }
  });
  return terms;
}

// ---------- 统一入口 ----------

// 传入文件名 + ArrayBuffer（也兼容 TypedArray/Buffer），返回 { terms, format }
export async function parseGlossaryArrayBuffer(fileName, arrayBuffer) {
  const name = (fileName || '').toLowerCase();
  // 兼容传入 TypedArray/Buffer 的情况，统一转成独立 ArrayBuffer
  let buf = arrayBuffer;
  if (!(arrayBuffer instanceof ArrayBuffer) && arrayBuffer && arrayBuffer.buffer) {
    const { buffer, byteOffset, byteLength } = arrayBuffer;
    buf = (byteOffset === 0 && byteLength === buffer.byteLength)
      ? buffer
      : buffer.slice(byteOffset, byteOffset + byteLength);
  }

  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
    const bytes = new Uint8Array(buf);
    const dv = new DataView(buf);
    const stringsXmlBytes = await readZipEntry(buf, bytes, dv, 'xl/sharedStrings.xml');
    const sharedStrings = stringsXmlBytes ? parseSharedStrings(new TextDecoder('utf-8').decode(stringsXmlBytes)) : [];
    const sheetBytes = await readZipEntry(buf, bytes, dv, 'xl/worksheets/sheet1.xml');
    if (!sheetBytes) throw new Error('Excel 文件里找不到工作表内容');
    const rows = parseSheetXml(new TextDecoder('utf-8').decode(sheetBytes));
    // 回填共享字符串
    rows.forEach((row) => {
      for (let i = 0; i < row.length; i++) {
        if (row[i] && typeof row[i] === 'object' && '__sharedIndex' in row[i]) {
          row[i] = sharedStrings[row[i].__sharedIndex] ?? '';
        }
      }
    });
    const terms = rowsToTerms(rows);
    if (terms.length === 0) throw new Error('Excel 里没解析到有效术语（需要源文本和译文列都不为空）');
    return { terms, format: 'Excel (.xlsx)' };
  }

  if (name.endsWith('.xls')) {
    throw new Error('旧版 .xls 格式不支持，请在 Excel/WPS 里另存为 .xlsx 或 .csv 再上传');
  }

  // .json / .csv / .txt 按文本处理
  const text = new TextDecoder('utf-8').decode(new Uint8Array(buf));

  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    const terms = rowsToTerms(parseCsv(text));
    if (terms.length === 0) throw new Error('CSV 里没解析到有效术语（需要源文本和译文列都不为空）');
    return { terms, format: name.endsWith('.csv') ? 'CSV' : '文本' };
  }

  // 默认按 JSON 处理（含 JSON Lines）
  let data;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  } catch (e) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      try {
        data = lines.map(l => JSON.parse(l));
      } catch (e2) {
        throw new Error('不是合法的 JSON 文件');
      }
    } else {
      throw new Error('不是合法的 JSON 文件');
    }
  }
  const arr = extractTermArray(data);
  if (!arr) throw new Error('JSON 顶层必须是术语数组，或包含 terms/data 等数组字段');
  const terms = jsonEntriesToTerms(arr);
  if (terms.length === 0) throw new Error('JSON 里没解析到有效术语');
  return { terms, format: 'JSON' };
}

// 浏览器 File 对象入口
export async function parseGlossaryFile(file) {
  return parseGlossaryArrayBuffer(file.name, await file.arrayBuffer());
}

// ---------- 生成 ----------

function csvEscape(v) {
  return '"' + String(v ?? '').replace(/"/g, '""') + '"';
}

// 生成 CSV 文本（带 BOM，Excel 双击打开中文不乱码）
export function termsToCsv(terms) {
  const lines = [['source', 'target', 'notes'].map(csvEscape).join(',')];
  terms.forEach(t => {
    lines.push([t.source, t.target, t.notes || ''].map(csvEscape).join(','));
  });
  return '\uFEFF' + lines.join('\r\n');
}

// ---------- xlsx 生成 ----------

function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

async function deflateRaw(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function buildSheetXml(rows) {
  const rowXml = rows.map((cells, r) => {
    const cellXml = cells.map((v, c) => {
      const ref = String.fromCharCode(65 + c) + (r + 1);
      // 统一用 inlineStr，避免维护 sharedStrings
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v ?? '')}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cellXml}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
}

// 把若干文件打包成 xlsx（ZIP），返回 ArrayBuffer
async function buildZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const rawBytes = typeof content === 'string' ? encoder.encode(content) : content;
    const compBytes = rawBytes.length > 64 ? await deflateRaw(rawBytes) : rawBytes;
    const method = rawBytes.length > 64 ? 8 : 0;
    const crc = crc32(rawBytes);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);          // version needed
    local.setUint16(6, 0x0800, true);      // UTF-8 文件名
    local.setUint16(8, method, true);
    local.setUint16(10, 0, true);          // mod time
    local.setUint16(12, 0x21, true);       // mod date (1980-01-01)
    local.setUint32(14, crc, true);
    local.setUint32(18, compBytes.length, true);
    local.setUint32(22, rawBytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, compBytes);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, method, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, compBytes.length, true);
    cd.setUint32(24, rawBytes.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true);
    cd.setUint16(32, 0, true);
    cd.setUint16(34, 0, true);
    cd.setUint16(36, 0, true);
    cd.setUint32(38, 0, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + compBytes.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  central.forEach(c => { cdSize += c.length; });

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, Object.keys(files).length, true);
  eocd.setUint16(10, Object.keys(files).length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);

  const totalLen = offset + cdSize + 22;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  [...chunks, ...central, new Uint8Array(eocd.buffer)].forEach(c => {
    out.set(c, pos);
    pos += c.length;
  });
  return out.buffer;
}

// 生成 xlsx ArrayBuffer
export async function termsToXlsx(terms) {
  const rows = [['source', 'target', 'notes'], ...terms.map(t => [t.source, t.target, t.notes || ''])];
  return buildZip({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="glossary" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': buildSheetXml(rows),
  });
}
