/* oxlint-disable typescript-eslint/no-explicit-any -- sherpa-onnx native addon has no type definitions */
import { join } from 'node:path'
import { speechRecognizerPackageName } from '../../shared/speech-recognizer-package'
import { resampleToRate } from './stt-audio-resample'
import { OfflineAudioChunker } from './stt-offline-audio-chunker'
import { buildRecognizerConfig } from './stt-worker-model-config'
import { createStopTailPadding } from './stt-stop-tail-padding'
import type { SttEngine, SttEngineInit, SttEnginePost } from './stt-worker-engine'

export function createSherpaEngine(init: SttEngineInit, post: SttEnginePost): SttEngine {
  // Use the platform native addon: the main sherpa-onnx WASM package cannot load host model files.
  const sherpa: any = require(
    join(init.speechModulesDir, speechRecognizerPackageName(process.platform, process.arch))
  )
  const { streaming: isStreaming, sampleRate: modelSampleRate } = init
  const { online, config } = buildRecognizerConfig(init)
  const recognizer = online
    ? sherpa.createOnlineRecognizer(config)
    : sherpa.createOfflineRecognizer(config)
  let stream = online
    ? sherpa.createOnlineStream(recognizer)
    : sherpa.createOfflineStream(recognizer)
  let offlineChunker = isStreaming ? null : new OfflineAudioChunker(modelSampleRate)
  // Primed on a session's first feed so stop never waits on the next session's stream.
  let streamPrimed = false
  // Streaming models report the same hypothesis on most 100 ms feeds; only changes are posted.
  let lastPartialText = ''

  // Offline streams are single-use; refresh even after failed decodes on a warm worker.
  const decodeOfflineChunk = (samples: Float32Array): string => {
    try {
      sherpa.acceptWaveformOffline(stream, { sampleRate: modelSampleRate, samples })
      sherpa.decodeOfflineStream(recognizer, stream)
      const result = JSON.parse(sherpa.getOfflineStreamResultAsJson(stream))
      return result?.text?.trim() ?? ''
    } finally {
      stream = sherpa.createOfflineStream(recognizer)
    }
  }

  const readOnlineText = (): string =>
    JSON.parse(sherpa.getOnlineStreamResultAsJson(recognizer, stream))?.text?.trim() ?? ''

  const feedOnline = (samples: Float32Array): void => {
    if (!streamPrimed) {
      // New streams start with empty encoder caches; zipformer en-20M dropped most of the first second
      // (first word wrong on 71 of 73 LibriSpeech clips). A second of silence fills them first.
      sherpa.acceptWaveformOnline(stream, {
        sampleRate: modelSampleRate,
        samples: new Float32Array(modelSampleRate)
      })
      streamPrimed = true
    }
    sherpa.acceptWaveformOnline(stream, { sampleRate: modelSampleRate, samples })
    while (sherpa.isOnlineStreamReady(recognizer, stream)) {
      sherpa.decodeOnlineStream(recognizer, stream)
    }
    const text = readOnlineText()
    if (text && text !== lastPartialText) {
      lastPartialText = text
      post({ type: 'partial', text })
    }
    if (sherpa.isEndpoint(recognizer, stream)) {
      if (text) {
        post({ type: 'final', text })
      }
      sherpa.reset(recognizer, stream)
      lastPartialText = ''
    }
  }

  const feedOffline = (samples: Float32Array): void => {
    // Bound ONNX allocations below Chromium's >=2GiB crash threshold (#7925); consumers append final segments.
    const readyChunks = offlineChunker?.push(new Float32Array(samples)) ?? []
    // push() already consumed these windows; decode later ones after failures using the refreshed stream.
    let firstError: unknown = null
    for (const chunk of readyChunks) {
      try {
        const text = decodeOfflineChunk(chunk)
        if (text) {
          post({ type: 'final', text })
        }
      } catch (err) {
        firstError ??= err
      }
    }
    if (firstError) {
      throw firstError
    }
  }

  return {
    feed(samples, sampleRate) {
      // Normalize rates before native decode: mixed rates on one recognizer abort the process.
      const resampled = resampleToRate(samples, sampleRate || modelSampleRate, modelSampleRate)
      if (isStreaming) {
        feedOnline(resampled)
      } else {
        feedOffline(resampled)
      }
    },
    finish() {
      if (isStreaming) {
        sherpa.acceptWaveformOnline(stream, {
          sampleRate: modelSampleRate,
          samples: createStopTailPadding(modelSampleRate)
        })
        sherpa.inputFinished(stream)
        while (sherpa.isOnlineStreamReady(recognizer, stream)) {
          sherpa.decodeOnlineStream(recognizer, stream)
        }
        const text = readOnlineText()
        if (text) {
          post({ type: 'final', text })
        }
        return
      }
      // flush() leaves less than one bounded chunk.
      const remaining = offlineChunker?.flush()
      if (remaining && remaining.length > 0) {
        const text = decodeOfflineChunk(remaining)
        if (text) {
          post({ type: 'final', text })
        }
      }
    },
    reset() {
      streamPrimed = false
      lastPartialText = ''
      if (!isStreaming) {
        offlineChunker = new OfflineAudioChunker(modelSampleRate)
      }
      stream = isStreaming
        ? sherpa.createOnlineStream(recognizer)
        : sherpa.createOfflineStream(recognizer)
    }
  }
}
