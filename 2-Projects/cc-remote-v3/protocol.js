/**
 * cc-remote v3 — Binary Protocol (Layered)
 *
 * 分层设计：
 *   Layer 1 (Browser ↔ Server):  简单帧 [opcode][payload]         — 无 reqId
 *   Layer 2 (Relay ↔ Tunnel):    完整帧 [opcode][reqId][payload]   — 有 reqId，用于多路复用
 *
 * Relay 和 Tunnel 在边界做 reqId 插入/剥离。
 *
 * Opcode:
 *   0x01 = terminal output (server → browser)
 *   0x02 = terminal input  (browser → server)
 *   0x03 = terminal resize (browser → server, payload = 4 bytes: cols + rows as uint16 BE)
 *   0x04 = replay buffer   (server → browser, 初次连接回放)
 *
 * 控制消息仍然走 JSON text frame（HTTP 代理、SSE、心跳等）。
 */

const OP_TERMINAL_OUTPUT = 0x01;
const OP_TERMINAL_INPUT  = 0x02;
const OP_TERMINAL_RESIZE = 0x03;
const OP_REPLAY_BUFFER   = 0x04;

const REQ_ID_LEN = 16; // 16 bytes = 32 hex chars

// ============ 简单帧（Browser ↔ Server）============

/**
 * 编码简单帧（无 reqId）
 * @param {number} opcode
 * @param {Buffer|string} payload
 * @returns {Buffer}
 */
function encodeSimpleFrame(opcode, payload) {
  const payloadBuf = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const frame = Buffer.allocUnsafe(1 + payloadBuf.length);
  frame[0] = opcode;
  payloadBuf.copy(frame, 1);
  return frame;
}

/**
 * 解码简单帧
 * @param {Buffer} data
 * @returns {{ opcode: number, payload: Buffer }}
 */
function decodeSimpleFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return { opcode: buf[0], payload: buf.slice(1) };
}

// ============ 完整帧（Relay ↔ Tunnel）============

/**
 * 编码完整帧（含 reqId）
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
 * 解码完整帧
 * @param {Buffer} data
 * @returns {{ opcode: number, reqId: string, payload: Buffer }}
 */
function decodeBinaryFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return {
    opcode: buf[0],
    reqId: buf.slice(1, 1 + REQ_ID_LEN).toString("hex"),
    payload: buf.slice(1 + REQ_ID_LEN),
  };
}

// ============ reqId 插入/剥离（边界转换）============

/**
 * 简单帧 → 完整帧（插入 reqId）
 * @param {Buffer} simpleFrame - [opcode][payload]
 * @param {string} reqIdHex - 32 char hex
 * @returns {Buffer} - [opcode][reqId][payload]
 */
function insertReqId(simpleFrame, reqIdHex) {
  const buf = Buffer.isBuffer(simpleFrame) ? simpleFrame : Buffer.from(simpleFrame);
  const reqIdBuf = Buffer.from(reqIdHex, "hex");
  const full = Buffer.allocUnsafe(1 + REQ_ID_LEN + buf.length - 1);
  full[0] = buf[0]; // opcode
  reqIdBuf.copy(full, 1, 0, REQ_ID_LEN);
  buf.copy(full, 1 + REQ_ID_LEN, 1); // payload (skip opcode)
  return full;
}

/**
 * 完整帧 → 简单帧（剥离 reqId）
 * @param {Buffer} fullFrame - [opcode][reqId][payload]
 * @returns {{ reqId: string, simple: Buffer }} - simple = [opcode][payload]
 */
function stripReqId(fullFrame) {
  const buf = Buffer.isBuffer(fullFrame) ? fullFrame : Buffer.from(fullFrame);
  const reqId = buf.slice(1, 1 + REQ_ID_LEN).toString("hex");
  const payload = buf.slice(1 + REQ_ID_LEN);
  const simple = Buffer.allocUnsafe(1 + payload.length);
  simple[0] = buf[0]; // opcode
  payload.copy(simple, 1);
  return { reqId, simple };
}

// ============ Resize 辅助 ============

/**
 * 解码 resize payload（4 bytes: cols + rows）
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
  encodeSimpleFrame,
  decodeSimpleFrame,
  encodeBinaryFrame,
  decodeBinaryFrame,
  insertReqId,
  stripReqId,
  decodeResize,
};
