import { engineDictationLanguage } from '../../shared/dictation-language'
import { getCatalogModel, isLocalSpeechModel } from './model-catalog'
import { launchSttWorker } from './stt-session-start'
import { isSttSessionBusy, type SttSessionState } from './stt-session-state'
import { scheduleSttIdleTeardown, teardownSttWorker } from './stt-session-stop'
import { getSherpaModulePath } from './stt-worker-paths'

/** Loads a downloaded local model before the first dictation, so the shortcut starts listening at once. */
export function prewarmSttModel(
  state: SttSessionState,
  modelId: string,
  language: string | undefined
): Promise<void> {
  const warming = (state.warming ?? Promise.resolve())
    .then(() => warmSttModel(state, modelId, language))
    .catch((error: unknown) => console.warn('[speech] Model pre-warm failed:', modelId, error))
    .finally(() => {
      if (state.warming === warming) {
        state.warming = null
      }
    })
  state.warming = warming
  return warming
}

async function warmSttModel(
  state: SttSessionState,
  modelId: string,
  language: string | undefined
): Promise<void> {
  // "Immediately" means no model stays loaded between dictations.
  if (state.idleUnloadMs === 0 || isSttSessionBusy(state)) {
    return
  }
  const manifest = getCatalogModel(modelId)
  if (!manifest || !isLocalSpeechModel(manifest) || !getSherpaModulePath()) {
    return
  }
  const engineLanguage = engineDictationLanguage(manifest, language)
  // Same key startSttSession reuses a warm worker by; desktop and phone starts pass no hotwords.
  const isWarm = (): boolean =>
    state.worker !== null &&
    state.activeModelId === modelId &&
    state.activeHotwordsFilePath === undefined &&
    state.activeLanguage === engineLanguage
  if (isWarm()) {
    return
  }
  const modelState = await state.modelManager.getModelState(modelId)
  if (modelState.status !== 'ready' || isSttSessionBusy(state)) {
    return
  }
  if (state.worker) {
    await teardownSttWorker(state, state.worker)
  }
  if (state.worker || isSttSessionBusy(state)) {
    return
  }
  await launchSttWorker(state, modelId, manifest, undefined, engineLanguage, null)
  if (isWarm() && !isSttSessionBusy(state)) {
    scheduleSttIdleTeardown(state)
  }
}
