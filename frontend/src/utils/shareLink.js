import { toast } from '../store/toastStore'

// Системный «Поделиться», где он есть (телефоны), иначе — ссылка в буфер.
// Safari пускает share()/clipboard только сразу после тапа, поэтому вызывать
// без сетевых ожиданий перед этим.
export async function shareLink({ title, text, url }) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url })
    } catch {
      // AbortError — пользователь закрыл шторку, это не ошибка.
    }
    return
  }
  try {
    await navigator.clipboard.writeText(url)
    toast.success('Ссылка скопирована')
  } catch {
    toast.error('Не удалось скопировать')
  }
}
