import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as TranscribeCpp from 'transcribe-cpp'
import { resampleToRate } from './stt-audio-resample'
import { OfflineAudioChunker } from './stt-offline-audio-chunker'
import { resolveFile } from './stt-worker-model-config'
import type { SttEngine, SttEngineInit, SttEnginePost } from './stt-worker-engine'

// Past ~8 threads decode slowed 2-4x under load in the 2026-11 benchmark; E-cores and SMT siblings don't help.
function performanceCoreThreads(): number {
  const logical = availableParallelism()
  let cores = Math.floor(logical / 2)
  if (process.platform === 'darwin') {
    try {
      cores = Number(
        execFileSync('sysctl', ['-n', 'hw.perflevel0.physicalcpu'], { encoding: 'utf8' })
      )
    } catch {
      // Older macOS has no perflevel split; keep the logical/2 estimate.
    }
  }
  return Math.min(logical, 8, Math.max(4, cores || 1))
}

// The hotwords file is written in sherpa's format, one `term :score` per line.
function readVocabulary(path: string | undefined): string[] {
  if (!path) {
    return []
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/\s+:[\d.]+\s*$/, '').trim())
    .filter(Boolean)
}

export async function createTranscribeCppEngine(
  init: SttEngineInit,
  post: SttEnginePost
): Promise<SttEngine> {
  const entry = join(init.speechModulesDir, 'transcribe-cpp', 'dist', 'index.js')
  const transcribe: typeof TranscribeCpp = await import(pathToFileURL(entry).href)
  const model = await transcribe.TranscribeModel.load(
    resolveFile(init.files, '.gguf', init.modelDir, '.gguf')
  )
  const session = model.createSession({ nThreads: performanceCoreThreads() })
  const vocabulary = readVocabulary(init.hotwordsFilePath)
  const options: TranscribeCpp.TranscribeOptions = {
    timestamps: 'none',
    ...(init.language && model.capabilities.languages.includes(init.language)
      ? { language: init.language }
      : {}),
    ...(vocabulary.length > 0 && model.supports('vocabulary') ? { vocabulary } : {})
  }
  const modelRate = model.capabilities.nativeSampleRate || init.sampleRate
  let chunker = new OfflineAudioChunker(modelRate)
  let inputRate = modelRate
  let decodedSamples = 0

  // Coverage is in input-rate samples so the host can trim the audio it keeps for a CPU replay.
  const decode = async (chunk: Float32Array): Promise<void> => {
    const { text } = await session.run(chunk, options)
    decodedSamples += chunk.length
    post({
      type: 'chunk',
      text: text.trim(),
      samples: Math.round((decodedSamples * inputRate) / modelRate)
    })
  }

  return {
    async feed(samples, sampleRate) {
      inputRate = sampleRate || modelRate
      // The binding borrows PCM until the run settles; resampleToRate may return the caller's buffer.
      const resampled = new Float32Array(resampleToRate(samples, inputRate, modelRate))
      for (const chunk of chunker.push(resampled)) {
        await decode(chunk)
      }
    },
    async finish() {
      const remaining = chunker.flush()
      if (remaining) {
        await decode(remaining)
      }
    },
    reset() {
      chunker = new OfflineAudioChunker(modelRate)
      decodedSamples = 0
    }
  }
}
