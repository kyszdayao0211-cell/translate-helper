// 在浏览器 / 扩展环境里直接解析 .docx，提取纯文本。
// .docx 本质是一个 ZIP，正文在 word/document.xml。
// 用浏览器原生的 DecompressionStream('deflate-raw') 解压，无需第三方库。

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&'); // & 放最后，避免二次转义
}

// 把 word/document.xml 转成纯文本：段落转换行，制表/换行标签保留
function docxXmlToText(xml) {
  const paragraphs = xml.split(/<\/w:p>/);
  const lines = paragraphs.map((p) => {
    p = p
      .replace(/<w:tab\b[^>]*\/?>/g, '\t')
      .replace(/<w:br\b[^>]*\/?>/g, '\n');
    let out = '';
    const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(p)) !== null) {
      out += m[1];
    }
    return decodeXmlEntities(out);
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// 传入 ArrayBuffer，返回文档纯文本
export async function extractDocxText(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);

  // 1. 从文件末尾往前找 End of Central Directory 记录 (签名 0x06054b50)
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 Word (.docx) 文件');

  const cdCount = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);

  // 2. 遍历中央目录，找 word/document.xml
  const CDH_SIG = 0x02014b50;
  let ptr = cdOffset;
  let target = null;
  for (let i = 0; i < cdCount; i++) {
    if (dv.getUint32(ptr, true) !== CDH_SIG) break;
    const compMethod = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const localOffset = dv.getUint32(ptr + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    if (name === 'word/document.xml') {
      target = { compMethod, compSize, localOffset };
      break;
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  if (!target) throw new Error('这个 Word 文件里找不到正文内容');

  // 3. 定位本地文件头，算出压缩数据的真正起始位置
  const LFH_SIG = 0x04034b50;
  const lo = target.localOffset;
  if (dv.getUint32(lo, true) !== LFH_SIG) throw new Error('Word 文件解析失败');
  const lNameLen = dv.getUint16(lo + 26, true);
  const lExtraLen = dv.getUint16(lo + 28, true);
  const dataStart = lo + 30 + lNameLen + lExtraLen;
  const compData = bytes.subarray(dataStart, dataStart + target.compSize);

  // 4. 解压（0=未压缩，8=deflate）
  let xmlBytes;
  if (target.compMethod === 0) {
    xmlBytes = compData;
  } else if (target.compMethod === 8) {
    xmlBytes = await inflateRaw(compData);
  } else {
    throw new Error('不支持的 Word 压缩格式');
  }

  const xml = new TextDecoder('utf-8').decode(xmlBytes);
  return docxXmlToText(xml);
}

// 根据文件类型提取文本：.docx 走解析，.txt/.md 直接读
export async function extractGuideFromFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.docx')) {
    const buf = await file.arrayBuffer();
    return extractDocxText(buf);
  }
  if (name.endsWith('.doc')) {
    throw new Error('旧版 .doc 格式不支持，请另存为 .docx 或 .txt 再上传');
  }
  // txt / md / 其它纯文本
  return (await file.text()).trim();
}
