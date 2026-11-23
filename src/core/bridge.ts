import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
  type ImageRawDataUpdateResult,
} from '@evenrealities/even_hub_sdk'
import { log } from './log'

// ---------------------------------------------------------------------------
// Serial call queue
//
// Every glasses-bound call shares one BLE link. Concurrent render + storage
// calls can crash the connection, and a flaky hop can hang for ~30 s, so all
// of them go through one queue with a per-call timeout.
// Phone-only calls (location, camera, album) do NOT go through the queue:
// they can wait on the user for a long time and do not touch BLE.
// ---------------------------------------------------------------------------

let tail: Promise<unknown> = Promise.resolve()

export function enqueue<T>(label: string, fn: () => Promise<T>, timeoutMs = 6000): Promise<T> {
  const run = () => withTimeout(label, fn(), timeoutMs)
  const p = tail.then(run, run)
  tail = p.catch(() => undefined)
  return p
}

export function withTimeout<T>(label: string, p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timeout after ${ms} ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

// ---------------------------------------------------------------------------
// Page model
// ---------------------------------------------------------------------------

interface Box {
  id: number
  name: string // max 16 chars, unique per page
  x: number
  y: number
  w: number
  h: number
  z?: number // zOrderIndex: all-or-nothing per page
}

export interface TextSpec extends Box {
  kind: 'text'
  content: string // max 1000 chars on create/rebuild
  border?: number // 0-5
  borderColor?: number // 0-15
  radius?: number // 0-10
  padding?: number // 0-32
  brightness?: number // textColor 0-4 (SDK 0.0.16+), default 4
  capture?: boolean
}

export interface ListSpec extends Box {
  kind: 'list'
  items: string[] // 1-20 items, max 64 chars each
  border?: number
  borderColor?: number
  radius?: number
  padding?: number
  selectBorder?: boolean
  capture?: boolean
}

export interface ImageSpec extends Box {
  kind: 'image' // w 20-288, h 20-144
}

export type ContainerSpec = TextSpec | ListSpec | ImageSpec

export interface MenuItem {
  id: number // non-zero
  label: string // max 32 UTF-8 bytes (about 10 Japanese characters)
}

export interface PageSpec {
  containers: ContainerSpec[]
  menu?: MenuItem[] // contextual menu, max 10 items
}

// ---------------------------------------------------------------------------
// Glasses facade
// ---------------------------------------------------------------------------

let bridge: EvenAppBridge
let created = false
let pageGeneration = 0
const pendingText = new Map<string, { id: number; name: string; content: string }>()
let flushScheduled = false

export function initGlasses(b: EvenAppBridge) {
  bridge = b
}

export function getBridge(): EvenAppBridge {
  return bridge
}

function toPayload(spec: PageSpec) {
  const texts: TextContainerProperty[] = []
  const lists: ListContainerProperty[] = []
  const images: ImageContainerProperty[] = []
  for (const c of spec.containers) {
    const base = {
      xPosition: c.x,
      yPosition: c.y,
      width: c.w,
      height: c.h,
      containerID: c.id,
      containerName: c.name,
      ...(c.z !== undefined ? { zOrderIndex: c.z } : {}),
    }
    if (c.kind === 'text') {
      texts.push(
        new TextContainerProperty({
          ...base,
          content: c.content.length > 0 ? c.content : ' ',
          borderWidth: c.border ?? 0,
          borderColor: c.borderColor ?? 5,
          borderRadius: c.radius ?? 0,
          paddingLength: c.padding ?? 4,
          isEventCapture: c.capture ? 1 : 0,
          ...(c.brightness !== undefined ? { textColor: c.brightness } : {}),
        }),
      )
    } else if (c.kind === 'list') {
      lists.push(
        new ListContainerProperty({
          ...base,
          borderWidth: c.border ?? 0,
          borderColor: c.borderColor ?? 5,
          borderRadius: c.radius ?? 0,
          paddingLength: c.padding ?? 4,
          isEventCapture: c.capture ? 1 : 0,
          itemContainer: new ListItemContainerProperty({
            itemCount: c.items.length,
            itemWidth: 0,
            isItemSelectBorderEn: c.selectBorder === false ? 0 : 1,
            itemName: c.items,
          }),
        }),
      )
    } else {
      images.push(new ImageContainerProperty(base))
    }
  }
  return {
    containerTotalNum: spec.containers.length,
    ...(texts.length ? { textObject: texts } : {}),
    ...(lists.length ? { listObject: lists } : {}),
    ...(images.length ? { imageObject: images } : {}),
    ...(spec.menu?.length
      ? {
          menuObject: new MenuContainerProperty({
            menuItems: spec.menu.map(m => new MenuItemProperty({ itemID: m.id, itemName: m.label })),
          }),
        }
      : {}),
  }
}

/**
 * Show a page. The first call uses the one-shot createStartUpPageContainer;
 * every later call uses rebuildPageContainer. If create fails (for example
 * after a Vite full reload, when the host already has a startup page), it
 * falls back to rebuild so development reloads keep working.
 */
export async function renderPage(spec: PageSpec): Promise<boolean> {
  pageGeneration++
  pendingText.clear()
  const payload = toPayload(spec)
  return enqueue('renderPage', async () => {
    if (!created) {
      created = true
      const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(payload))
      if (result === 0) return true
      log(`createStartUpPageContainer → ${result}. rebuild で再試行`)
    }
    const ok = await bridge.rebuildPageContainer(new RebuildPageContainer(payload))
    if (!ok) log('rebuildPageContainer が false を返しました')
    return ok
  })
}

/**
 * Flicker-free text update. Updates are coalesced per container, so a
 * 10 Hz sensor feed never builds a backlog on the BLE link.
 */
export function setText(id: number, name: string, content: string) {
  pendingText.set(name, { id, name, content })
  if (flushScheduled) return
  flushScheduled = true
  const generation = pageGeneration
  void enqueue('textContainerUpgrade', async () => {
    flushScheduled = false
    if (generation !== pageGeneration) return
    const items = [...pendingText.values()]
    pendingText.clear()
    for (const it of items) {
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: it.id, containerName: it.name, content: it.content }),
      )
    }
  }).catch(e => log(`テキスト更新失敗: ${String(e)}`))
}

/** Send PNG bytes (or raw grey pixels) to an image container. Serial by design. */
export function sendImage(id: number, name: string, data: number[]): Promise<ImageRawDataUpdateResult> {
  return enqueue(
    'updateImageRawData',
    () => bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: id, containerName: name, imageData: data })),
    20000,
  )
}
