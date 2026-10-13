import type { Lesson, Module } from '../types/lessons'

export const BUILTIN_MODULE_ID = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1'
export const BUILTIN_LESSON_WELCOME_ID = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b201'
export const BUILTIN_LESSON_TWO_ID = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b202'
export const BROKER10_SIGNUP_URL = 'https://broker10.com/registrate-ahora'

export const BUILTIN_LESSON_CATALOG: {
  modules: Module[]
  lessons: Lesson[]
  materials: []
} = {
  modules: [
    {
      id: BUILTIN_MODULE_ID,
      title: 'Lory Sinais',
      description: null,
      order_index: 0,
      is_published: true,
    },
  ],
  lessons: [
    {
      id: BUILTIN_LESSON_WELCOME_ID,
      module_id: BUILTIN_MODULE_ID,
      title: 'Aula de bem-vindos',
      description: null,
      youtube_url: 'https://youtu.be/zr3Esd6wU7Y',
      youtube_video_id: 'zr3Esd6wU7Y',
      duration_seconds: null,
      order_index: 0,
      is_published: true,
    },
    {
      id: BUILTIN_LESSON_TWO_ID,
      module_id: BUILTIN_MODULE_ID,
      title: 'Aula dois',
      description: null,
      youtube_url: 'https://youtu.be/-xqggDcknlU',
      youtube_video_id: '-xqggDcknlU',
      duration_seconds: null,
      order_index: 1,
      is_published: true,
    },
  ],
  materials: [],
}
