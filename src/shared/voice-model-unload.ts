import type { VoiceSettings } from './speech-types'

/** Choices the Voice pane offers: null never unloads, 0 unloads as soon as a dictation ends. */
export const UNLOAD_MODEL_AFTER_MINUTES_CHOICES = [null, 0, 5, 15, 60] as const

export const DEFAULT_UNLOAD_MODEL_AFTER_MINUTES = 15

/** How long an idle on-device model stays loaded, in ms; null keeps it loaded. */
export function voiceModelUnloadDelayMs(
  voice: Pick<VoiceSettings, 'unloadModelAfterMinutes'> | undefined
): number | null {
  const minutes = voice?.unloadModelAfterMinutes
  if (minutes === null) {
    return null
  }
  const valid = typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0
  return (valid ? minutes : DEFAULT_UNLOAD_MODEL_AFTER_MINUTES) * 60_000
}
