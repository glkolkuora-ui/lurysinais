import { useState, useEffect, useCallback } from 'react'
import { appApi } from '../lib/app-api'
import type { Lesson, ModuleWithLessons } from '../types/lessons'
import { resolveLessonVideoId, youtubeEmbedSrc } from '../lib/youtube'
import { useI18n } from '../i18n/I18nProvider'
import {
  BROKER10_SIGNUP_URL,
  BUILTIN_LESSON_CATALOG,
  BUILTIN_LESSON_TWO_ID,
  BUILTIN_LESSON_WELCOME_ID,
} from '../lib/builtin-lessons'

const WATCHED_KEY = 'hackinvest_watched_lessons'

function readLocalWatched(): Set<string> {
  try {
    const raw = localStorage.getItem(WATCHED_KEY)
    const list = raw ? JSON.parse(raw) as string[] : []
    return new Set(Array.isArray(list) ? list : [])
  } catch {
    return new Set()
  }
}

function writeLocalWatched(ids: Set<string>) {
  try { localStorage.setItem(WATCHED_KEY, JSON.stringify([...ids])) } catch { /* ignore */ }
}

export default function Aulas() {
  const { t } = useI18n()
  const [modules, setModules] = useState<ModuleWithLessons[]>([])
  const [watchedIds, setWatchedIds] = useState<Set<string>>(new Set())
  const [selectedLesson, setSelectedLesson] = useState<Lesson | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [embedContext, setEmbedContext] = useState<{ origin: string; pageUrl: string } | null>(null)
  const [playerEpoch, setPlayerEpoch] = useState(0)

  useEffect(() => {
    void window.claudePro?.appGetEmbedOrigin?.()
      .then((ctx) => setEmbedContext(ctx))
      .catch(() => {
        if (typeof window !== 'undefined' && window.location?.protocol !== 'file:') {
          setEmbedContext({
            origin: window.location.origin,
            pageUrl: window.location.href,
          })
        }
      })
  }, [])

  useEffect(() => {
    void window.claudePro?.appGetUserId?.().then(({ userId: uid }) => {
      setUserId(uid)
    }).catch((err) => {
      console.error('[AULAS] Erro ao obter user_id:', err)
    })
  }, [])

  const loadContent = useCallback(async () => {
    setLoading(true)
    try {
      const catalog = await appApi<{
        ok?: boolean
        modules?: any[]
        lessons?: any[]
        materials?: any[]
        error?: string
      }>('/api/lessons/catalog')

      const fallback = BUILTIN_LESSON_CATALOG
      const mods = catalog.ok && catalog.modules?.length ? catalog.modules : fallback.modules
      const lessons = catalog.ok && catalog.lessons?.length ? catalog.lessons : fallback.lessons
      const materials = catalog.ok ? catalog.materials ?? [] : fallback.materials

      if (!mods.length) {
        setModules([])
        setSelectedLesson(null)
        return
      }

      const lessonsByModule = new Map<string, Lesson[]>()
      lessons?.forEach((l) => {
        const arr = lessonsByModule.get(l.module_id) ?? []
        arr.push({
          ...l,
          materials: materials?.filter((m) => m.lesson_id === l.id) ?? [],
        })
        lessonsByModule.set(l.module_id, arr)
      })

      const withLessons = mods.map((m) => ({
        ...m,
        lessons: lessonsByModule.get(m.id) ?? [],
      }))

      setModules(withLessons)
      const first = withLessons.flatMap((m) => m.lessons)[0] ?? null
      setSelectedLesson(first)
    } catch (err) {
      console.error('[AULAS] Erro ao carregar:', err)
      const mods = BUILTIN_LESSON_CATALOG.modules.map((m) => ({
        ...m,
        lessons: BUILTIN_LESSON_CATALOG.lessons.filter((l) => l.module_id === m.id),
      }))
      setModules(mods)
      setSelectedLesson(mods.flatMap((m) => m.lessons)[0] ?? null)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadProgress = useCallback(async () => {
    const local = readLocalWatched()
    if (!userId) {
      setWatchedIds(local)
      return
    }
    try {
      const data = await appApi<{ watched_lesson_ids?: string[] }>('/api/lessons/progress/list', {
        user_id: userId,
      })
      const merged = new Set([...(data.watched_lesson_ids ?? []), ...local])
      setWatchedIds(merged)
      writeLocalWatched(merged)
    } catch (err) {
      console.error('[AULAS] Erro ao carregar progresso:', err)
      setWatchedIds(local)
    }
  }, [userId])

  useEffect(() => {
    void loadContent()
  }, [loadContent])

  useEffect(() => {
    void loadProgress()
  }, [loadProgress])

  const orderedLessons = modules.flatMap((m) => m.lessons)
  function lessonTitle(lesson: Lesson) {
    if (lesson.id === BUILTIN_LESSON_WELCOME_ID) return t('lessons.welcome')
    if (lesson.id === BUILTIN_LESSON_TWO_ID) return t('lessons.two')
    return lesson.title
  }

  const selectedVideoId = selectedLesson ? resolveLessonVideoId(selectedLesson) : null
  const selectedEmbedSrc =
    selectedVideoId && selectedVideoId !== 'about:blank'
      ? youtubeEmbedSrc(selectedVideoId, {
          origin: embedContext?.origin,
          pageUrl: embedContext?.pageUrl,
        })
      : null

  if (loading) {
    return (
      <div className="aulas-page page-content">
        <div className="aulas-loading-state">
          <div className="aulas-loading-spinner" aria-hidden />
          <p>{t('lessons.loading')}</p>
        </div>
      </div>
    )
  }

  function selectLesson(lesson: Lesson) {
    setSelectedLesson(lesson)
    setPlayerEpoch((n) => n + 1)
  }

  if (modules.length === 0) {
    return (
      <div className="aulas-page page-content">
        <div className="aulas-empty-state">
          <p className="aulas-empty-title">{t('lessons.emptyTitle')}</p>
          <p className="aulas-empty-desc">{t('lessons.emptyDesc')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="aulas-page page-content">
      <header className="aulas-top">
        <div className="aulas-top-intro">
          <h1 className="aulas-title">{t('lessons.title')}</h1>
          <p className="aulas-subtitle">{t('lessons.subtitle')}</p>
        </div>
      </header>

      <section className="aulas-trilha" aria-label={t('lessons.trackAria')}>
        {selectedLesson && (
          <>
            <h2 className="aula-detail-title">{lessonTitle(selectedLesson)}</h2>
            <div className="aulas-player-section" aria-label={t('lessons.videoAria')}>
              <div className="video-player-shell">
                <div className="video-player">
                  {selectedEmbedSrc ? (
                    <iframe
                      key={`${selectedLesson.id}-${selectedVideoId}-${playerEpoch}`}
                      src={selectedEmbedSrc}
                      title={lessonTitle(selectedLesson)}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
                      allowFullScreen
                      referrerPolicy="strict-origin-when-cross-origin"
                    />
                  ) : (
                    <div className="video-player-placeholder">
                      <p>{t('lessons.videoUnavailable')}</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <a
              className="aulas-broker-link"
              href={BROKER10_SIGNUP_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('lessons.brokerSignup')}
            </a>
          </>
        )}

        <ul className="aulas-card-list">
          {orderedLessons.map((lesson, index) => (
            <li key={lesson.id}>
              <button
                type="button"
                className={['aulas-card', selectedLesson?.id === lesson.id ? 'aulas-card--active' : ''].filter(Boolean).join(' ')}
                onClick={() => selectLesson(lesson)}
              >
                <span className="aulas-card-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="aulas-card-body">
                  <span className="aulas-card-title">{lessonTitle(lesson)}</span>
                  <span className="aulas-card-cta">{t('lessons.watch')} →</span>
                </span>
                {watchedIds.has(lesson.id) && (
                  <span className="aulas-card-watched">{t('lessons.watched')}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
