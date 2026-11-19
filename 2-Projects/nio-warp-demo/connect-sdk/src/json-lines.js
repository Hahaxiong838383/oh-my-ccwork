// Read bounded byte frames, rather than readline's unbounded line accumulator.
export async function consumeJSONLines(input, onValue, onError) {
  const maxBytes = 8192;
  let parts = [], size = 0, overlong = false;
  const finish = async () => {
    if (overlong) await onError('line_too_long');
    else if (size > 0) {
      const text = Buffer.concat(parts, size).toString('utf8').trim();
      if (text) {
        let value;
        try { value = JSON.parse(text); } catch { await onError('invalid_json'); }
        if (value !== undefined) await onValue(value);
      }
    }
    parts = []; size = 0; overlong = false;
  };
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline === -1 ? bytes.length : newline;
      const length = end - offset;
      if (!overlong && size + length <= maxBytes) {
        if (length) parts.push(bytes.subarray(offset, end));
        size += length;
      } else { overlong = true; parts = []; size = 0; }
      offset = end + 1;
      if (newline !== -1) await finish();
    }
  }
  await finish();
}
