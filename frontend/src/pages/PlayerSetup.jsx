import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useUiSettingsStore } from '../store/uiSettingsStore'
import { clearPlayerSetupStage, markPlayerSetupSeen, readPlayerSetupStage, savePlayerSetupStage } from '../services/playerSetup'
import PlayerSetupScreen from '../components/PlayerSetupScreen'

export default function PlayerSetup() {
  const navigate = useNavigate()
  const userId = useAuthStore((s) => s.user?.id)
  const completePlayerSetup = useAuthStore((s) => s.completePlayerSetup)
  const [stage, setStage] = useState(() => readPlayerSetupStage(userId))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const savingRef = useRef(false)
  const moveTo = (next) => {
    savePlayerSetupStage(userId, next)
    setStage(next)
  }
  const finish = async () => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      const result = await completePlayerSetup()
      if (!result.success) { setError(result.error); return }
      // Make the newly configured CD player visible even if an older local
      // preference had hidden compact discs on this device.
      useUiSettingsStore.setState({ vinylDisc: true })
      clearPlayerSetupStage(userId)
      // Старые аккаунты проходят коробку один раз: дальше гейт их не трогает.
      markPlayerSetupSeen(userId)
      navigate('/', { replace: true })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return <PlayerSetupScreen stage={stage} onStageChange={moveTo} onFinish={finish} saving={saving} error={error} />
}
