import type { ModelManager } from './model-manager'
import type { SpawnSttWorkerProcess } from './stt-worker-process'
import { prewarmSttModel } from './stt-session-prewarm'
import { startSttDictation } from './stt-session-start'
import { createSttSessionState, isSttSessionBusy, type SttSessionState } from './stt-session-state'
import {
  prepareSttModelForDeletion,
  scheduleSttIdleTeardown,
  stopSttDictation,
  teardownIdleSttWorker
} from './stt-session-stop'

export { START_DICTATION_TIMEOUT_MS } from './stt-session-timeouts'

export type SttEvent =
  | { type: 'ready' }
  | { type: 'partial'; text?: string }
  | { type: 'final'; text?: string }
  | { type: 'stopped' }
  | { type: 'error'; error?: string }

export type SttEventSink = (event: SttEvent) => void

export class SttService {
  private readonly state: SttSessionState

  constructor(modelManager: ModelManager, spawnWorker: SpawnSttWorkerProcess) {
    this.state = createSttSessionState(modelManager, spawnWorker)
  }

  startDictation(
    modelId: string,
    sink: SttEventSink,
    hotwordsFilePath?: string,
    owner = 'desktop',
    language?: string
  ): Promise<void> {
    return startSttDictation(this.state, modelId, sink, hotwordsFilePath, owner, language)
  }

  feedAudio(samples: Float32Array, sampleRate: number, owner = 'desktop'): boolean {
    if (this.state.stopping) {
      return false
    }
    const currentOwner = this.state.activeOwner ?? this.state.startingOwner
    if (!currentOwner) {
      return false
    }
    if (currentOwner !== owner) {
      throw new Error('dictation_owner_mismatch')
    }
    if (this.state.cloudSession) {
      return this.state.cloudSession.feedAudio(samples, sampleRate)
    }
    this.state.worker?.postMessage({ type: 'feed', samples, sampleRate })
    return false
  }

  stopDictation(
    owner = 'desktop',
    options: { cancelStarting?: boolean; discard?: boolean } = { cancelStarting: true }
  ): Promise<void> {
    return stopSttDictation(this.state, owner, options)
  }

  isActive(): boolean {
    return this.state.worker !== null || this.state.cloudSession !== null
  }

  getActiveModelId(): string | null {
    return this.state.activeModelId
  }

  prepareModelForDeletion(modelId: string): Promise<void> {
    return prepareSttModelForDeletion(this.state, modelId)
  }

  /** The one warm-up entry point; an engine that needs a first inference to be fast does it behind this. */
  prewarm(modelId: string, language?: string): Promise<void> {
    return prewarmSttModel(this.state, modelId, language)
  }

  /** null keeps an idle model loaded; 0 unloads it as soon as a dictation ends. */
  setIdleUnloadDelay(ms: number | null): void {
    if (this.state.idleUnloadMs === ms) {
      return
    }
    this.state.idleUnloadMs = ms
    // An in-flight pre-warm schedules its own unload once loaded.
    if (this.state.worker && !this.state.warming && !isSttSessionBusy(this.state)) {
      scheduleSttIdleTeardown(this.state)
    }
  }

  unloadIdleModel(): Promise<void> {
    return teardownIdleSttWorker(this.state)
  }
}
