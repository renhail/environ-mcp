/**
 * 纯 JS MD5 实现（RFC 1321）。
 *
 * 为什么不用 node:crypto：绑定页和 OAuth 授权页都要在**浏览器里**对密码做 MD5，
 * 而 Web Crypto API 不支持 MD5（只有 SHA-1/256/384/512），所以只能自带实现。
 *
 * 与 environ 前端（crypto-js/md5）结果一致：32 位小写十六进制。
 *
 * 函数是自包含的（常量都定义在函数体内），
 * 这样可以直接用 `md5Hex.toString()` 注入到 HTML 模板里在浏览器中执行。
 */

/**
 * 计算字符串的 MD5（32 位小写 hex）。
 * @param {string} str 原始字符串（按 UTF-8 编码处理）
 * @returns {string} 32 位小写十六进制
 */
export function md5Hex(str) {
  // K[i] = floor(abs(sin(i+1)) * 2^32)，MD5 标准常量表
  var K = new Array(64);
  // 每轮 4 步、共 4 轮的循环左移位数
  var S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  for (var ki = 0; ki < 64; ki++) {
    K[ki] = Math.floor(Math.abs(Math.sin(ki + 1)) * 4294967296);
  }

  // UTF-8 编码：把字符串转成字节序列
  var utf8 = unescape(encodeURIComponent(String(str)));

  // 填充：0x80 + 若干 0x00，使长度 ≡ 56 (mod 64)，末尾 8 字节写比特长度
  var msgLen = utf8.length;
  var withOne = msgLen + 1;
  var padLen = ((56 - (withOne % 64)) + 64) % 64;
  var total = withOne + padLen + 8;
  var bytes = new Array(total);
  for (var bi = 0; bi < msgLen; bi++) bytes[bi] = utf8.charCodeAt(bi) & 0xff;
  bytes[msgLen] = 0x80;
  for (var pi = msgLen + 1; pi < total - 8; pi++) bytes[pi] = 0;
  // 比特长度（小端 64 位，JS 用两个 32 位）
  var bitLenLo = (msgLen << 3) >>> 0;
  var bitLenHi = Math.floor(msgLen / 536870912) >>> 0; // msgLen * 8 / 2^32
  for (var q = 0; q < 4; q++) {
    bytes[total - 8 + q] = (bitLenLo >>> (q * 8)) & 0xff;
    bytes[total - 4 + q] = (bitLenHi >>> (q * 8)) & 0xff;
  }

  // 初始状态
  var a0 = 0x67452301;
  var b0 = 0xefcdab89;
  var c0 = 0x98badcfe;
  var d0 = 0x10325476;

  var M = new Array(16);
  for (var off = 0; off < total; off += 64) {
    for (var m = 0; m < 16; m++) {
      var j = off + m * 4;
      M[m] = (bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24)) >>> 0;
    }

    var A = a0, B = b0, C = c0, D = d0;
    for (var i = 0; i < 64; i++) {
      var F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  function leHex(x) {
    var s = "";
    for (var i2 = 0; i2 < 4; i2++) {
      s += ("0" + ((x >>> (i2 * 8)) & 0xff).toString(16)).slice(-2);
    }
    return s;
  }
  return leHex(a0) + leHex(b0) + leHex(c0) + leHex(d0);
}
