import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpeechModelStatus } from '../../shared/speech-types'
import { SttService } from './stt-service'
import { SttWorkerChildProcess } from './stt-worker-process'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

vi.mock('./model-catalog', () => ({
  isLocalSpeechModel: () => true,
  getCatalogModel: (id: string) => ({
    id,
    type: 'transducer',
    provider: 'local',
    streaming: true,
    sampleRate: 16000,
    files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']
  })
}))

type FakeChild = { worker: SttWorkerChildProcess; inits: number; killed: boolean }

function createService(
  options: { status?: SpeechModelStatus; answerInit?: boolean; answerStop?: boolean } = {}
): {
  service: SttService
  children: FakeChild[]
} {
  const children: FakeChild[] = []
  const spawn = (): SttWorkerChildProcess => {
    const child: FakeChild = {
      inits: 0,
      killed: false,
      worker: new SttWorkerChildProcess({
        send: (message) => {
          const type = Reflect.get(message, 'type')
          if (type === 'init') {
            child.inits += 1
            if (options.answerInit !== false) {
              queueMicrotask(() => child.worker.receiveMessage({ type: 'ready' }))
            }
          } else if ((type === 'stop' || type === 'discard') && options.answerStop !== false) {
            queueMicrotask(() => child.worker.receiveMessage({ type: 'stopped' }))
          }
        },
        kill: () => {
          child.killed = true
          child.worker.receiveExit(0)
        }
      })
    }
    children.push(child)
    return child.worker
  }
  const models = {
    getModelState: vi.fn(async (id: string) => ({ id, status: options.status ?? 'ready' })),
    getModelDir: (id: string) => `/tmp/${id}`
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a local start reads only getModelState and getModelDir.
  return { service: new SttService(models as never, spawn), children }
}

describe('SttService model pre-warm', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads the model before the first dictation, which then reuses it', async () => {
    const { service, children } = createService()
    const sink = vi.fn()

    await service.prewarm('model-a')
    expect(children).toHaveLength(1)
    await service.startDictation('model-a', sink, undefined, 'desktop')

    expect(children).toHaveLength(1)
    expect(children[0].inits).toBe(1)
    expect(sink).toHaveBeenCalledWith({ type: 'ready' })
  })

  it('holds a dictation started mid pre-warm until the model has loaded', async () => {
    const { service, children } = createService({ answerInit: false })
    const sink = vi.fn()

    const warming = service.prewarm('model-a')
    await vi.waitFor(() => expect(children[0]?.inits).toBe(1))
    const start = service.startDictation('model-a', sink, undefined, 'desktop')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sink).not.toHaveBeenCalled()

    children[0].worker.receiveMessage({ type: 'ready' })
    await Promise.all([warming, start])

    expect(children).toHaveLength(1)
    expect(sink).toHaveBeenCalledWith({ type: 'ready' })
  })

  it('lets a loading model finish before unloading it, so the next dictation is not stuck', async () => {
    const { service, children } = createService({ answerInit: false })

    const warming = service.prewarm('model-a')
    await vi.waitFor(() => expect(children[0]?.inits).toBe(1))
    const unload = service.unloadIdleModel()
    children[0].worker.receiveMessage({ type: 'ready' })
    await Promise.all([warming, unload])
    expect(children[0].killed).toBe(true)

    const start = service.startDictation('model-a', vi.fn(), undefined, 'desktop')
    await vi.waitFor(() => expect(children[1]?.inits).toBe(1))
    children[1].worker.receiveMessage({ type: 'ready' })
    await start
  })

  it('cancels a dictation that waited on a pre-warm without loading the model again', async () => {
    const { service, children } = createService({ answerInit: false, answerStop: false })

    const warming = service.prewarm('model-a')
    await vi.waitFor(() => expect(children[0]?.inits).toBe(1))
    const start = service.startDictation('model-a', vi.fn(), undefined, 'desktop')
    const cancel = service.stopDictation('desktop', { discard: true })
    // The worker answers the cancel only after it has finished loading.
    children[0].worker.receiveMessage({ type: 'ready' })
    await expect(start).rejects.toThrow('dictation_canceled')
    children[0].worker.receiveMessage({ type: 'stopped' })
    await Promise.all([warming, cancel])
    expect(children).toHaveLength(1)
    expect(children[0].killed).toBe(false)
  })

  it('does not load a model that is not downloaded', async () => {
    const { service, children } = createService({ status: 'not-downloaded' })

    await service.prewarm('model-a')

    expect(children).toHaveLength(0)
  })

  it('unloads a pre-warmed model after the default 15 idle minutes', async () => {
    vi.useFakeTimers()
    const { service, children } = createService()

    await service.prewarm('model-a')
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1)
    expect(children[0].killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(children[0].killed).toBe(true)
  })

  it('keeps an idle model loaded when set to never unload', async () => {
    vi.useFakeTimers()
    const { service, children } = createService()
    service.setIdleUnloadDelay(null)

    await service.prewarm('model-a')
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)

    expect(children[0].killed).toBe(false)
  })

  it('skips pre-warm and unloads after each dictation when set to immediately', async () => {
    vi.useFakeTimers()
    const { service, children } = createService()
    service.setIdleUnloadDelay(0)

    await service.prewarm('model-a')
    expect(children).toHaveLength(0)
    await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
    await service.stopDictation('desktop')
    await vi.advanceTimersByTimeAsync(0)

    expect(children[0].killed).toBe(true)
  })

  it('unloads the idle model at once when the setting changes to immediately', async () => {
    const { service, children } = createService()
    await service.prewarm('model-a')

    service.setIdleUnloadDelay(0)

    await vi.waitFor(() => expect(children[0].killed).toBe(true))
  })
})
