import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

export type Gesture = 'tap' | 'double' | 'up' | 'down' | 'longStart' | 'longEnd'
export type Source = 'right' | 'left' | 'ring' | 'unknown'
export type Lifecycle = 'foregroundEnter' | 'foregroundExit' | 'abnormalExit' | 'systemExit'

export type Input =
  | { kind: 'gesture'; gesture: Gesture; source: Source; via: 'sys' | 'text' | 'list'; listIndex?: number; listName?: string }
  | { kind: 'menu'; itemId: number }
  | { kind: 'lifecycle'; type: Lifecycle }
  | { kind: 'imu'; x: number; y: number; z: number }
  | { kind: 'audio'; pcm: Uint8Array; source: string; direction: number | null; speakerRole: string }

export const GESTURE_LABEL: Record<Gesture, string> = {
  tap: 'タップ',
  double: 'ダブルタップ',
  up: '上スワイプ',
  down: '下スワイプ',
  longStart: '長押し開始',
  longEnd: '長押し終了',
}

export const SOURCE_LABEL: Record<Source, string> = {
  right: '右ツル',
  left: '左ツル',
  ring: 'リング',
  unknown: '不明',
}

function gestureOf(type: number): Gesture | null {
  switch (type) {
    case OsEventTypeList.CLICK_EVENT: return 'tap'
    case OsEventTypeList.SCROLL_TOP_EVENT: return 'up'
    case OsEventTypeList.SCROLL_BOTTOM_EVENT: return 'down'
    case OsEventTypeList.DOUBLE_CLICK_EVENT: return 'double'
    case OsEventTypeList.LONG_PRESS_EVENT: return 'longStart'
    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT: return 'longEnd'
    default: return null
  }
}

function sourceOf(raw: number | undefined): Source {
  switch (raw) {
    case 1: return 'right'
    case 2: return 'ring'
    case 3: return 'left'
    default: return 'unknown'
  }
}

/**
 * Normalize one EvenHubEvent envelope.
 *
 * Protobuf omits zero values, so CLICK_EVENT (0) arrives as an undefined
 * eventType, and the first list item (index 0) as an undefined index. The
 * default is resolved inside each envelope check, never across envelopes,
 * so an IMU or audio frame can never be misread as a tap.
 */
export function parseEvent(event: EvenHubEvent): Input | null {
  if (event.menuItemClickEvent) {
    return { kind: 'menu', itemId: event.menuItemClickEvent.itemID ?? 0 }
  }

  if (event.audioEvent) {
    const a = event.audioEvent
    return { kind: 'audio', pcm: a.audioPcm, source: String(a.source), direction: a.direction ?? null, speakerRole: String(a.speakerRole) }
  }

  if (event.listEvent) {
    const l = event.listEvent
    const g = gestureOf(l.eventType ?? OsEventTypeList.CLICK_EVENT)
    if (!g) return null
    return { kind: 'gesture', gesture: g, source: 'unknown', via: 'list', listIndex: l.currentSelectItemIndex ?? 0, listName: l.currentSelectItemName }
  }

  if (event.textEvent) {
    const g = gestureOf(event.textEvent.eventType ?? OsEventTypeList.CLICK_EVENT)
    if (!g) return null
    return { kind: 'gesture', gesture: g, source: 'unknown', via: 'text' }
  }

  if (event.sysEvent) {
    const s = event.sysEvent
    const type = s.eventType ?? OsEventTypeList.CLICK_EVENT
    if (type === OsEventTypeList.IMU_DATA_REPORT || s.imuData) {
      if (!s.imuData) return null
      return { kind: 'imu', x: s.imuData.x ?? 0, y: s.imuData.y ?? 0, z: s.imuData.z ?? 0 }
    }
    switch (type) {
      case OsEventTypeList.FOREGROUND_ENTER_EVENT: return { kind: 'lifecycle', type: 'foregroundEnter' }
      case OsEventTypeList.FOREGROUND_EXIT_EVENT: return { kind: 'lifecycle', type: 'foregroundExit' }
      case OsEventTypeList.ABNORMAL_EXIT_EVENT: return { kind: 'lifecycle', type: 'abnormalExit' }
      case OsEventTypeList.SYSTEM_EXIT_EVENT: return { kind: 'lifecycle', type: 'systemExit' }
    }
    const g = gestureOf(type)
    if (!g) return null
    return { kind: 'gesture', gesture: g, source: sourceOf(s.eventSource), via: 'sys' }
  }

  return null
}
