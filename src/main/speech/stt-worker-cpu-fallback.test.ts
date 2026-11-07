import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { spawnSttWorkerWithCpuFallback } from './stt-worker-cpu-fallback'

class FakeChild extends EventEmitter {
  readonly posted: { type: string; samples?: Float32Array }[] = []
  constructor(readonly cpuOnly: boolean) {
    super()
  }
  postMessage(message: { type: string; samples?: Float32Array }): void {
    this.posted.push(message)
  }
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
  unref(): void {}
}

function setup(): {
  worker: ReturnType<typeof spawnSttWorkerWithCpuFallback>
  children: FakeChild[]
  events: unknown[]
  marks: () => number
} {
  const children: FakeChild[] = []
  let marks = 0
  const worker = spawnSttWorkerWithCpuFallback(
    ({ cpuOnly }) => {
      const child = new FakeChild(cpuOnly)
      children.push(child)
      return child
    },
    { allowGpu: () => true, markGpuFailed: () => void (marks += 1) }
  )
  const events: unknown[] = []
  worker.on('message', (event: unknown) => events.push(event))
  worker.postMessage({ type: 'init', files: ['model-Q8_0.gguf'] })
  return { worker, children, events, marks: () => marks }
}

const feed = (n: number): { type: 'feed'; samples: Float32Array; sampleRate: number } => ({
  type: 'feed',
  samples: new Float32Array(n),
  sampleRate: 16000
})

describe('GPU speech process falling back to the CPU', () => {
  it('replays only the audio the GPU had not decoded when it crashes mid-stop', () => {
    const { worker, children, events, marks } = setup()
    const [gpu] = children
    gpu.emit('message', { type: 'ready' })
    worker.postMessage(feed(300))
    worker.postMessage(feed(300))
    gpu.emit('message', { type: 'chunk', text: 'first', samples: 400 })
    worker.postMessage(feed(300))
    worker.postMessage({ type: 'stop' })
    gpu.emit('exit', 1)
    // The dead process's late messages must not settle the stop or duplicate text.
    gpu.emit('message', { type: 'chunk', text: 'late', samples: 900 })
    gpu.emit('message', { type: 'stopped' })

    const cpu = children[1]
    expect(cpu.cpuOnly).toBe(true)
    expect(cpu.posted.map((m) => [m.type, m.samples?.length])).toEqual([
      ['init', undefined],
      ['feed', 200],
      ['feed', 300],
      ['stop', undefined]
    ])
    expect(marks()).toBe(0)
    cpu.emit('message', { type: 'ready' })
    expect(marks()).toBe(1)
    cpu.emit('message', { type: 'chunk', text: 'second', samples: 500 })
    cpu.emit('message', { type: 'stopped' })
    expect(events).toEqual([
      { type: 'ready' },
      { type: 'final', text: 'first' },
      { type: 'final', text: 'second' },
      { type: 'stopped' }
    ])
  })

  it('keeps the GPU for later sessions when only this audio failed', () => {
    const { worker, children, marks } = setup()
    const [gpu] = children
    gpu.emit('message', { type: 'ready' })
    worker.postMessage(feed(100))
    gpu.emit('message', { type: 'error', error: 'bad input' })
    children[1].emit('message', { type: 'ready' })
    expect(marks()).toBe(0)
  })

  it('does not replay a canceled dictation', () => {
    const { worker, children } = setup()
    const [gpu] = children
    gpu.emit('message', { type: 'ready' })
    worker.postMessage(feed(100))
    worker.postMessage({ type: 'discard' })
    gpu.emit('exit', 1)
    expect(children[1].posted.map((m) => m.type)).toEqual(['init', 'discard'])
  })
})
