/** Bounded test protocol; byte framing and application semantics stay consumer-owned. */
export function channel(stream, onClose = () => {}) {
  const limit = 64 * 1024, queue = []
  let buffered = Buffer.alloc(0), waiting, closed
  const fail = error => {
    if (closed) return
    closed = error
    waiting?.reject(error); waiting = undefined
    onClose(error)
  }
  stream.on('error', fail)
  stream.on('end', () => fail(new Error('control EOF')))
  stream.on('close', () => fail(new Error('control closed')))
  stream.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk])
    for (;;) {
      const end = buffered.indexOf(10)
      if (end < 0) break
      if (end > limit) { stream.destroy(new Error('frame exceeds limit')); return }
      let value
      try { value = JSON.parse(buffered.subarray(0, end).toString()) }
      catch { stream.destroy(new Error('invalid control JSON')); return }
      buffered = buffered.subarray(end + 1)
      if (waiting) { waiting.resolve(value); waiting = undefined }
      else if (queue.length < 16) queue.push(value)
      else { stream.destroy(new Error('receive queue exceeds limit')); return }
    }
    if (buffered.length > limit) stream.destroy(new Error('frame exceeds limit'))
  })
  return {
    async send(value) {
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
      if (closed) throw closed
      if (bytes.length > limit) throw new Error('frame exceeds limit')
      // This fixture permits one request at a time; await the writable callback
      // before issuing another frame instead of accumulating a write queue.
      await new Promise((resolve, reject) => stream.write(bytes, error => error ? reject(error) : resolve()))
    },
    next() {
      if (queue.length) return Promise.resolve(queue.shift())
      if (closed) return Promise.reject(closed)
      if (waiting) throw new Error('one consumer per channel')
      waiting = Promise.withResolvers()
      return waiting.promise
    },
  }
}

export async function within(promise, ms = 10_000, label = 'operation') {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)
    })])
  } finally { clearTimeout(timer) }
}
