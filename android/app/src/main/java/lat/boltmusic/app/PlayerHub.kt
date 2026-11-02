package lat.boltmusic.app

import android.os.SystemClock

/**
 * Состояние плеера страницы, каким его видит navigator.mediaSession.
 * Пишет MainActivity (из моста), читает PlaybackService. Один процесс,
 * всё на главном потоке.
 */
object PlayerHub {
    data class Metadata(
        val title: String,
        val artist: String,
        val album: String,
        val artworkUrl: String,
    )

    var metadata: Metadata? = null
        private set
    var playbackState: String = "none"
        private set
    // null — старый фронт, который сообщает только mediaSession.playbackState.
    private var playbackRequested: Boolean? = null
    var actions: Set<String> = emptySet()
        private set

    /** Лайк и дизлайк текущего трека — для кнопок на системном плеере. */
    var liked: Boolean = false
        private set
    var disliked: Boolean = false
        private set

    /** Длительность и позиция в секундах; позиция снята в [positionAt]. */
    var duration: Double = 0.0
        private set
    var position: Double = 0.0
        private set
    var rate: Double = 1.0
        private set
    var positionAt: Long = 0L
        private set

    /** Кнопки системного плеера: страница выполняет их через __boltMediaAction. */
    var actionSink: ((action: String, seekTime: Double?) -> Unit)? = null

    private val listeners = LinkedHashSet<() -> Unit>()

    fun addListener(listener: () -> Unit) {
        listeners += listener
    }

    fun removeListener(listener: () -> Unit) {
        listeners -= listener
    }

    val isPlaying: Boolean get() = playbackState == "playing"
    val hasPlaybackRequest: Boolean get() = playbackRequested != null
    val isPlaybackRequested: Boolean get() = playbackRequested ?: isPlaying

    fun setPlaybackRequested(value: Boolean) {
        if (value == playbackRequested) return
        playbackRequested = value
        notifyListeners()
    }

    fun setMetadata(value: Metadata?) {
        metadata = value
        if (value == null) {
            duration = 0.0
            position = 0.0
        }
        notifyListeners()
    }

    fun setPlaybackState(value: String) {
        if (value == playbackState) return
        // Позиция продолжает тикать только во время игры: фиксируем, где
        // остановились, иначе системный ползунок уедет вперёд на паузе.
        position = currentPosition()
        positionAt = SystemClock.elapsedRealtime()
        playbackState = value
        notifyListeners()
    }

    fun setActions(value: Set<String>) {
        if (value == actions) return
        actions = value
        notifyListeners()
    }

    fun setFeedback(liked: Boolean, disliked: Boolean) {
        if (liked == this.liked && disliked == this.disliked) return
        this.liked = liked
        this.disliked = disliked
        notifyListeners()
    }

    fun setPosition(duration: Double, position: Double, rate: Double) {
        this.duration = duration
        this.position = position
        this.rate = rate
        positionAt = SystemClock.elapsedRealtime()
        notifyListeners()
    }

    fun currentPosition(): Double {
        if (!isPlaying) return position
        val elapsed = (SystemClock.elapsedRealtime() - positionAt) / 1000.0
        val value = position + elapsed * rate
        return if (duration > 0) value.coerceIn(0.0, duration) else value
    }

    fun dispatch(action: String, seekTime: Double? = null) {
        actionSink?.invoke(action, seekTime)
    }

    fun reset() {
        metadata = null
        playbackState = "none"
        playbackRequested = null
        actions = emptySet()
        liked = false
        disliked = false
        duration = 0.0
        position = 0.0
        notifyListeners()
    }

    private fun notifyListeners() {
        listeners.toList().forEach { it() }
    }
}
