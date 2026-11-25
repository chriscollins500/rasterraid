export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function modelBytes(stream, bytes, receive = () => {}) {
  const output = new Uint8Array(bytes);
  const reader = stream.getReader();
  let position = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (position + value.byteLength > bytes) throw new Error('Unexpected inference file size.');
      output.set(value, position);
      position += value.byteLength;
      receive(position);
    }
    if (position !== bytes) throw new Error('Unexpected inference file size.');
    return output;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function verifiedModelBytes(stream, { bytes, sha256 }, receive) {
  const output = await modelBytes(stream, bytes, receive);
  if (await sha256Hex(output) !== sha256) throw new Error('Inference file verification failed.');
  return output;
}

export async function unpackModel(stream, magic, parts, receive = () => {}) {
  const reader = stream.getReader();
  let pending = new Uint8Array();
  let consumed = 0;

  async function nextChunk() {
    while (!pending.length) {
      const { value, done } = await reader.read();
      if (done) return false;
      pending = value;
    }
    return true;
  }

  function take(length) {
    return new ReadableStream({
      async pull(controller) {
        if (!await nextChunk()) throw new Error('The visual model pack is truncated.');
        const count = Math.min(length, pending.length);
        controller.enqueue(pending.subarray(0, count));
        pending = pending.subarray(count);
        length -= count;
        consumed += count;
        receive(consumed);
        if (!length) controller.close();
      },
    });
  }

  try {
    const header = await modelBytes(take(magic.length), magic.length);
    if (new TextDecoder().decode(header) !== magic) throw new Error('Unexpected visual model pack.');
    const inputs = [];
    for (const part of parts) {
      const content = take(part.compressed).pipeThrough(new DecompressionStream('gzip'));
      inputs.push([part.key, await verifiedModelBytes(content, part)]);
    }
    if (await nextChunk()) throw new Error('Unexpected data after the visual model pack.');
    return Object.fromEntries(inputs);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
