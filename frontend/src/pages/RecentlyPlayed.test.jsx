import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import RecentlyPlayed from './RecentlyPlayed'

const makeTrack = (id, minutesAgo) => ({
  id,
  title: `Track ${id}`,
  artist: `Artist ${id}`,
  duration: 120,
  file_path: `/track/${id}`,
  cover_url: null,
  last_played: new Date(Date.now() - minutesAgo * 60000).toISOString(),
})

const pageOne = Array.from({ length: 30 }, (_, i) => makeTrack(i + 1, i))
const pageTwo = Array.from({ length: 5 }, (_, i) => makeTrack(31 + i, i))

const apiGet = vi.fn()
const apiDelete = vi.fn()
const playPlaylistMock = vi.fn()

vi.mock('../services/api', () => ({
  default: {
    get: (...args) => apiGet(...args),
    delete: (...args) => apiDelete(...args),
  },
}))

vi.mock('../store/playerStore', () => ({
  usePlayerStore: () => ({
    playPlaylist: playPlaylistMock,
    currentTrack: null,
  }),
}))

vi.mock('../utils/media', () => ({
  resolveCoverUrl: () => null,
}))

vi.mock('../assets/default-cover.svg', () => ({
  default: 'cover',
}))

const createObserver = () => {
  let callback
  return {
    observe: vi.fn(),
    disconnect: vi.fn(),
    trigger: (isIntersecting = true) => {
      if (callback) callback([{ isIntersecting }])
    },
    setCallback: (cb) => {
      callback = cb
    },
  }
}

describe('RecentlyPlayed page', () => {
  beforeEach(() => {
    apiGet.mockReset()
    apiDelete.mockReset()
    playPlaylistMock.mockReset()
    window.confirm = vi.fn(() => true)
  })

  it('loads first page and appends more on scroll', async () => {
    apiGet
      .mockResolvedValueOnce({ data: pageOne })
      .mockResolvedValueOnce({ data: pageTwo })

    const observer = createObserver()
    global.IntersectionObserver = vi.fn((cb) => {
      observer.setCallback(cb)
      return observer
    })

    render(
      <MemoryRouter>
        <RecentlyPlayed />
      </MemoryRouter>
    )

    expect(await screen.findByText('Недавно прослушанные')).toBeInTheDocument()
    expect(await screen.findByText('Track 1')).toBeInTheDocument()

    await act(async () => {
      observer.trigger(true)
    })

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledTimes(2)
    })

    expect(await screen.findByText('Track 31')).toBeInTheDocument()
  })

  it('clears history after confirmation', async () => {
    apiGet.mockResolvedValueOnce({ data: pageOne })
    apiDelete.mockResolvedValueOnce({ data: { message: 'History cleared' } })

    render(
      <MemoryRouter>
        <RecentlyPlayed />
      </MemoryRouter>
    )

    expect(await screen.findByText('Track 1')).toBeInTheDocument()
    const clearBtn = screen.getByRole('button', { name: /Очистить историю/i })
    await userEvent.click(clearBtn)

    await waitFor(() => {
      expect(apiDelete).toHaveBeenCalledWith('/tracks/me/recent')
      expect(screen.queryByText('Track 1')).not.toBeInTheDocument()
    })
  })

  it('plays all tracks from recent playlist', async () => {
    apiGet.mockResolvedValueOnce({ data: pageOne })

    render(
      <MemoryRouter>
        <RecentlyPlayed />
      </MemoryRouter>
    )

    await screen.findByText('Track 1')
    const playBtn = screen.getByRole('button', { name: /Слушать/i })
    await userEvent.click(playBtn)

    expect(playPlaylistMock).toHaveBeenCalled()
    expect(playPlaylistMock.mock.calls[0][1]).toBe(0)
    expect(playPlaylistMock.mock.calls[0][2]).toBe('recent')
  })

  it('does not clear history when confirmation canceled', async () => {
    apiGet.mockResolvedValueOnce({ data: pageOne })
    window.confirm = vi.fn(() => false)

    render(
      <MemoryRouter>
        <RecentlyPlayed />
      </MemoryRouter>
    )

    await screen.findByText('Track 1')
    const clearBtn = screen.getByRole('button', { name: /Очистить историю/i })
    await userEvent.click(clearBtn)

    expect(apiDelete).not.toHaveBeenCalled()
  })

  it('plays a selected track from the list', async () => {
    apiGet.mockResolvedValueOnce({ data: pageOne })

    render(
      <MemoryRouter>
        <RecentlyPlayed />
      </MemoryRouter>
    )

    const track = await screen.findByText('Track 2')
    await userEvent.click(track)

    expect(playPlaylistMock).toHaveBeenCalled()
    expect(playPlaylistMock.mock.calls[0][1]).toBe(1)
    expect(playPlaylistMock.mock.calls[0][2]).toBe('recent')
  })

  it('shows empty state when no recent tracks', async () => {
    apiGet.mockResolvedValueOnce({ data: [] })

    render(
      <MemoryRouter>
        <RecentlyPlayed />
      </MemoryRouter>
    )

    expect(await screen.findByText('За последние 48 часов нет прослушиваний')).toBeInTheDocument()
  })

  it('shows error when fetch fails', async () => {
    apiGet.mockRejectedValueOnce({ response: { data: { detail: 'Сервис недоступен' } } })

    render(
      <MemoryRouter>
        <RecentlyPlayed />
      </MemoryRouter>
    )

    expect(await screen.findByText('Сервис недоступен')).toBeInTheDocument()
  })

  it('shows error on clear history failure', async () => {
    apiGet.mockResolvedValueOnce({ data: pageOne })
    apiDelete.mockRejectedValueOnce({ response: { data: { detail: 'Ошибка' } } })

    render(
      <MemoryRouter>
        <RecentlyPlayed />
      </MemoryRouter>
    )

    await screen.findByText('Track 1')
    const clearBtn = screen.getByRole('button', { name: /Очистить историю/i })
    await userEvent.click(clearBtn)

    expect(await screen.findByText('Ошибка')).toBeInTheDocument()
  })
})
