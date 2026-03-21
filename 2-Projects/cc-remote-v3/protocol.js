/**
 * cc-remote v3 — Binary Protocol
 *
 * V3 核心优化：终端数据走二进制帧，控制消息走 JSON。
 *
 * 二进制帧格式（Terminal I/O）：
 *   [1 byte opcode][16 bytes reqId][payload...]
 *
 * Opcode:
 *   0x01 = terminal output (device → browser)
 *   0x02 = terminal input  (browser → device)
 *   0x03 = terminal resize (browser → device, payload = 2 bytes: cols, rows as uint16 BE)
 *   0x04 = replay buffer   (device → browser, 初次连接时回放)
 *
 * 控制消息仍然走 JSON text frame（HTTP 代理、SSE、会话管理、心跳等）。
 * 判断规则：Binary frame = 终端数据, Text frame = JSON 控制消息。
 */

const OP_TERMINAL_OUTPUT = 0x01;
const OP_TERMINAL_INPUT  = 0x02;
const OP_TERMINAL_RESIZE = 0x03;
const OP_REPLAY_BUFFER   = 0x04;

// reqId 固定 16 bytes（hex string 32 chars → 16 bytes binary）
const REQ_ID_LEN = 16;

/**
 * 编码终端二进制帧
 * @param {number} opcode
 * @param {string} reqId - 32 char hex string
 * @param {Buffer|string} payload
 * @returns {Buffer}
 */
function encodeBinaryFrame(opcode, reqId, payload) {
  const reqIdBuf = Buffer.from(reqId, "hex");
  const payloadBuf = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const frame = Buffer.allocUnsafe(1 + REQ_ID_LEN + payloadBuf.length);
  frame[0] = opcode;
  reqIdBuf.copy(frame, 1, 0, REQ_ID_LEN);
  payloadBuf.copy(frame, 1 + REQ_ID_LEN);
  return frame;
}

/**
 * 解码终端二进制帧
 * @param {Buffer} data
 * @returns {{ opcode: number, reqId: string, payload: Buffer }}
 */
function decodeBinaryFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const opcode = buf[0];
  const reqId = buf.slice(1, 1 + REQ_ID_LEN).toString("hex");
  const payload = buf.slice(1 + REQ_ID_LEN);
  return { opcode, reqId, payload };
}

/**
 * 编码 resize 帧
 * @param {string} reqId
 * @param {number} cols
 * @param {number} rows
 * @returns {Buffer}
 */
function encodeResize(reqId, cols, rows) {
  const payload = Buffer.allocUnsafe(4);
  payload.writeUInt16BE(cols, 0);
  payload.writeUInt16BE(rows, 2);
  return encodeBinaryFrame(OP_TERMINAL_RESIZE, reqId, payload);
}

/**
 * 解码 resize payload
 * @param {Buffer} payload
 * @returns {{ cols: number, rows: number }}
 */
function decodeResize(payload) {
  return {
    cols: payload.readUInt16BE(0),
    rows: payload.readUInt16BE(2),
  };
}

module.exports = {
  OP_TERMINAL_OUTPUT,
  OP_TERMINAL_INPUT,
  OP_TERMINAL_RESIZE,
  OP_REPLAY_BUFFER,
  REQ_ID_LEN,
  encodeBinaryFrame,
  decodeBinaryFrame,
  encodeResize,
  decodeResize,
};
