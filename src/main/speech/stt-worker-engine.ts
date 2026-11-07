import type { RecognizerConfigInput } from './stt-worker-model-config'

export type SttEngineInit = RecognizerConfigInput & {
  /** The node_modules directory holding this model's engine package. */
  speechModulesDir: string
}

export type SttEngineEvent =
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  /** One decoded offline chunk; `samples` counts the input-rate samples decoded so far this session. */
  | { type: 'chunk'; text: string; samples: number }

export type SttEnginePost = (event: SttEngineEvent) => void

/** One loaded model in the speech host child; calls never overlap. */
export type SttEngine = {
  feed(samples: Float32Array, sampleRate: number): void | Promise<void>
  /** Decode what is buffered and post its text; may throw after posting earlier chunks. */
  finish(): void | Promise<void>
  /** Drop buffered audio and stream state so the next session starts clean. */
  reset(): void
}
