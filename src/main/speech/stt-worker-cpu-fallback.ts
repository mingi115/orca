import { EventEmitter } from 'node:events'
import { speechEngineForModelFiles } from '../../shared/speech-model-engine'
import { OFFLINE_DECODE_CHUNK_SECONDS } from './stt-offline-audio-chunker'
import type { SttWorkerProcess } from './stt-worker-process'

export type SpawnSttChild = (options: { cpuOnly: boolean }) => SttWorkerProcess

export type SttGpuPolicy = {
  /** False when the user turned the GPU off or this machine's GPU already failed. */
  allowGpu(): boolean
  markGpuFailed(): void
}

type Feed = { type: 'feed'; samples: Float32Array; sampleRate: number }
type HostMessage =
  | { type: 'init'; files?: readonly string[] }
  | Feed
  | { type: 'stop' }
  | { type: 'discard' }
  | { type: 'teardown' }
type ChildMessage =
  | { type: 'chunk'; text: string; samples: number }
  | { type: 'ready' | 'stopped' | 'error' | 'partial' | 'final'; text?: string; error?: string }

// Well under the session's 60 s start and stop timeouts, so a CPU replay still fits; covers first-run shader compiles.
export const GPU_STALL_TIMEOUT_MS = 25_000

/**
 * Runs transcribe-cpp on the GPU and, when the GPU fails to load, errors, stalls or crashes the
 * process, moves the session to a CPU-only process and replays the audio not yet decoded.
 * Session code sees one worker throughout.
 */
class SttCpuFallbackWorker extends EventEmitter implements SttWorkerProcess {
  private child!: SttWorkerProcess
  private detachChild: () => void = () => undefined
  private cpuOnly: boolean
  private init: HostMessage | null = null
  private ready = false
  private pending: 'stop' | 'discard' | null = null
  private exitRequested = false
  private markOnCpuReady = false
  private buffered: Feed[] = []
  private bufferedStart = 0
  private stallTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly spawn: SpawnSttChild,
    private readonly gpu: SttGpuPolicy
  ) {
    super()
    this.cpuOnly = !gpu.allowGpu()
    this.attach(spawn({ cpuOnly: this.cpuOnly }))
  }

  postMessage(message: object): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: session code posts only the speech host protocol.
    const msg = message as HostMessage
    if (msg.type === 'init') {
      this.init = msg
      this.armStallTimer()
    } else if (msg.type === 'feed' && this.canFallBack()) {
      this.buffered.push(msg)
      // A full chunk is waiting, so the GPU should be decoding; arm before the backlog outgrows a replay.
      if (!this.stallTimer && this.bufferedSeconds() > OFFLINE_DECODE_CHUNK_SECONDS) {
        this.armStallTimer()
      }
    } else if (msg.type === 'stop' || msg.type === 'discard') {
      this.pending = msg.type
      if (msg.type === 'stop') {
        this.armStallTimer()
      }
    } else if (msg.type === 'teardown') {
      this.exitRequested = true
    }
    this.child.postMessage(msg)
  }

  terminate(): Promise<number> {
    this.exitRequested = true
    this.clearStallTimer()
    return this.child.terminate()
  }

  unref(): void {}

  private canFallBack(): boolean {
    return (
      !this.cpuOnly &&
      !this.exitRequested &&
      this.init?.type === 'init' &&
      speechEngineForModelFiles(this.init.files ?? []) === 'transcribe-cpp'
    )
  }

  private attach(child: SttWorkerProcess): void {
    const onMessage = (message: ChildMessage): void => this.receive(message)
    const onError = (error: Error): void =>
      this.canFallBack() ? this.fallBack(true) : this.forwardError(error)
    const onExit = (code: number): void => {
      // An idle process killed from outside (OOM, Activity Monitor) is not a GPU failure.
      const busy = !this.ready || this.pending !== null || this.buffered.length > 0
      if (this.canFallBack() && busy) {
        this.fallBack(true)
      } else {
        this.emit('exit', code)
      }
    }
    child.on('message', onMessage)
    child.on('error', onError)
    child.on('exit', onExit)
    this.child = child
    this.detachChild = () => {
      child.off('message', onMessage)
      child.off('error', onError)
      child.off('exit', onExit)
    }
  }

  private receive(message: ChildMessage): void {
    if (message.type === 'chunk') {
      if (this.pending !== 'stop') {
        this.clearStallTimer()
      }
      this.trimBuffered(message.samples)
      if (message.text) {
        this.emit('message', { type: 'final', text: message.text })
      }
      return
    }
    if (message.type === 'error' && this.canFallBack()) {
      this.fallBack(!this.ready)
      return
    }
    if (message.type === 'ready') {
      this.clearStallTimer()
      if (this.markOnCpuReady) {
        this.markOnCpuReady = false
        this.gpu.markGpuFailed()
      }
      if (this.ready) {
        return
      }
      this.ready = true
    } else if (message.type === 'stopped') {
      this.clearStallTimer()
      this.pending = null
      this.buffered = []
      this.bufferedStart = 0
    }
    this.emit('message', message)
  }

  /** `persist`: the GPU itself failed (crash, stall, load), not just this audio. */
  private fallBack(persist: boolean): void {
    this.clearStallTimer()
    this.detachChild()
    void this.child.terminate().catch(() => undefined)
    // Persist only once CPU loads the model: a broken model must not turn the GPU off.
    this.markOnCpuReady = persist
    this.cpuOnly = true
    this.attach(this.spawn({ cpuOnly: true }))
    if (this.init) {
      this.child.postMessage(this.init)
    }
    // A canceled dictation wants no text, so its audio is not replayed.
    if (this.pending !== 'discard') {
      for (const feed of this.buffered) {
        this.child.postMessage(feed)
      }
    }
    this.buffered = []
    if (this.pending) {
      this.child.postMessage({ type: this.pending })
    }
  }

  private trimBuffered(decodedSamples: number): void {
    while (this.buffered.length > 0) {
      const first = this.buffered[0]
      const end = this.bufferedStart + first.samples.length
      if (end > decodedSamples) {
        const keep = first.samples.subarray(decodedSamples - this.bufferedStart)
        this.buffered[0] = { ...first, samples: keep }
        this.bufferedStart = decodedSamples
        return
      }
      this.buffered.shift()
      this.bufferedStart = end
    }
  }

  private bufferedSeconds(): number {
    return this.buffered.reduce((total, feed) => total + feed.samples.length / feed.sampleRate, 0)
  }

  private armStallTimer(): void {
    this.clearStallTimer()
    if (!this.canFallBack()) {
      return
    }
    this.stallTimer = setTimeout(() => this.fallBack(true), GPU_STALL_TIMEOUT_MS)
    this.stallTimer.unref?.()
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer)
      this.stallTimer = null
    }
  }

  private forwardError(error: Error): void {
    // An 'error' with no listener would throw in main after session code detached.
    if (this.listenerCount('error') > 0) {
      this.emit('error', error)
    }
  }
}

export function spawnSttWorkerWithCpuFallback(
  spawn: SpawnSttChild,
  gpu: SttGpuPolicy
): SttWorkerProcess {
  return new SttCpuFallbackWorker(spawn, gpu)
}
