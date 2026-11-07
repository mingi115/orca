import { speechEngineForModelFiles } from '../../shared/speech-model-engine'
import { createSherpaEngine } from './stt-sherpa-engine'
import { createTranscribeCppEngine } from './stt-transcribe-cpp-engine'
import type { SttEngine, SttEngineInit } from './stt-worker-engine'
import { connectSttWorkerParentPort } from './stt-worker-parent-port'

type WorkerMessage =
  | ({ type: 'init' } & SttEngineInit)
  | { type: 'feed'; samples: Float32Array; sampleRate: number }
  | { type: 'stop' }
  | { type: 'discard' }
  | { type: 'teardown' }

const parentPort = connectSttWorkerParentPort()
let engine: SttEngine | null = null

async function handleInit(init: SttEngineInit): Promise<void> {
  try {
    engine =
      speechEngineForModelFiles(init.files) === 'transcribe-cpp'
        ? await createTranscribeCppEngine(init, (event) => parentPort.post(event))
        : createSherpaEngine(init, (event) => parentPort.post(event))
    parentPort.post({ type: 'ready' })
  } catch (err) {
    parentPort.post({ type: 'error', error: String(err) })
  }
}

// Discard residual audio and spent streams so a warm worker never carries one session into the next.
function resetSessionState(): void {
  try {
    engine?.reset()
  } catch {
    // The old stream still holds the last session's audio; exiting settles stop and forces a fresh worker.
    process.exit(1)
  }
}

async function handleFeed(msg: Extract<WorkerMessage, { type: 'feed' }>): Promise<void> {
  try {
    await engine?.feed(msg.samples, msg.sampleRate)
  } catch (err) {
    parentPort.post({ type: 'error', error: String(err) })
  }
}

async function handleStop(): Promise<void> {
  try {
    await engine?.finish()
  } catch (err) {
    parentPort.post({ type: 'error', error: String(err) })
  } finally {
    resetSessionState()
    // Recovery must not suppress the stopped signal awaited by stopDictation.
    parentPort.post({ type: 'stopped' })
  }
}

// A canceled dictation drops its audio undecoded so the warm worker is free at once.
function handleDiscard(): void {
  resetSessionState()
  parentPort.post({ type: 'stopped' })
}

function handleMessage(msg: WorkerMessage): void | Promise<void> {
  switch (msg.type) {
    case 'init':
      return handleInit(msg)
    case 'feed':
      return handleFeed(msg)
    case 'stop':
      return handleStop()
    case 'discard':
      return handleDiscard()
    case 'teardown':
      engine = null
      process.exit(0)
  }
}

// transcribe-cpp decodes off the event loop; one queue keeps feeds behind init and stop behind feeds.
let queue: Promise<void> = Promise.resolve()
parentPort.onMessage((message) => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the session host posts here, and it sends WorkerMessage.
  const msg = message as WorkerMessage
  queue = queue.then(() => handleMessage(msg))
})
