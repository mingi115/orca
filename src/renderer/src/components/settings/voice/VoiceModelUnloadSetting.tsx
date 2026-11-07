import { useId } from 'react'
import type { SpeechModelManifest, VoiceSettings } from '../../../../../shared/speech-types'
import {
  DEFAULT_UNLOAD_MODEL_AFTER_MINUTES,
  UNLOAD_MODEL_AFTER_MINUTES_CHOICES
} from '../../../../../shared/voice-model-unload'
import { translate } from '@/i18n/i18n'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SettingsRow } from '../form-controls/SettingsFormControls'

type UnloadChoice = (typeof UNLOAD_MODEL_AFTER_MINUTES_CHOICES)[number]

const NEVER_VALUE = 'never'

function isUnloadChoice(value: number | null | undefined): value is UnloadChoice {
  return UNLOAD_MODEL_AFTER_MINUTES_CHOICES.some((minutes) => minutes === value)
}

function choiceValue(minutes: UnloadChoice): string {
  return minutes === null ? NEVER_VALUE : String(minutes)
}

function choiceLabel(minutes: UnloadChoice): string {
  switch (minutes) {
    case null:
      return translate('components.settings.voice.modelUnload.never', 'Never')
    case 0:
      return translate('components.settings.voice.modelUnload.immediately', 'Immediately')
    case 5:
      return translate('components.settings.voice.modelUnload.fiveMinutes', 'After 5 minutes')
    case 15:
      return translate('components.settings.voice.modelUnload.fifteenMinutes', 'After 15 minutes')
    case 60:
      return translate('components.settings.voice.modelUnload.oneHour', 'After 1 hour')
  }
}

type VoiceModelUnloadSettingProps = {
  voiceSettings: VoiceSettings
  selectedModel: SpeechModelManifest | undefined
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

export function VoiceModelUnloadSetting({
  voiceSettings,
  selectedModel,
  onUpdateVoiceSettings
}: VoiceModelUnloadSettingProps): React.JSX.Element {
  const labelId = useId()
  const isCloudModel = selectedModel?.provider === 'openai'
  const saved: number | null | undefined = voiceSettings.unloadModelAfterMinutes
  const current = isUnloadChoice(saved) ? saved : DEFAULT_UNLOAD_MODEL_AFTER_MINUTES

  return (
    <SettingsRow
      label={translate('components.settings.voice.modelUnload.title', 'Unload Speech Model')}
      description={
        isCloudModel
          ? translate(
              'components.settings.voice.modelUnload.cloud',
              'Cloud models run on the provider’s servers, so nothing stays loaded here.'
            )
          : translate(
              'components.settings.voice.modelUnload.description',
              'Orca loads the on-device model while voice is on, so dictation starts at once. Choose when to free its memory after you stop dictating.'
            )
      }
      labelId={labelId}
      control={
        <Select
          value={choiceValue(current)}
          disabled={!voiceSettings.enabled || isCloudModel}
          onValueChange={(value) =>
            onUpdateVoiceSettings({
              unloadModelAfterMinutes: value === NEVER_VALUE ? null : Number(value)
            })
          }
        >
          <SelectTrigger size="sm" className="min-w-32" aria-labelledby={labelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {UNLOAD_MODEL_AFTER_MINUTES_CHOICES.map((minutes) => (
              <SelectItem key={choiceValue(minutes)} value={choiceValue(minutes)}>
                {choiceLabel(minutes)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  )
}
