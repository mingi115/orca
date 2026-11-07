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
  const localModel =
    manifest && isLocalSpeechModel(manifest) && getSherpaModulePath() ? manifest : null
  const engineLanguage = localModel ? engineDictationLanguage(localModel, language) : undefined
  // Same key startSttSession reuses a warm worker by; desktop and phone starts pass no hotwords.
  const isWarm = (): boolean =>
    state.worker !== null &&
    state.activeModelId === modelId &&
    state.activeHotwordsFilePath === undefined &&
    state.activeLanguage === engineLanguage
  if (localModel && isWarm()) {
    return
  }
  const ready =
    localModel !== null && (await state.modelManager.getModelState(modelId)).status === 'ready'
  if (isSttSessionBusy(state)) {
    return
  }
  // The idle worker holds a model that is no longer the selected one.
  if (state.worker) {
    await teardownSttWorker(state, state.worker)
  }
  if (!localModel || !ready || state.worker || isSttSessionBusy(state)) {
    return
  }
  await launchSttWorker(state, modelId, localModel, undefined, engineLanguage, null)
  if (isWarm() && !isSttSessionBusy(state)) {
    scheduleSttIdleTeardown(state)
  }
}
