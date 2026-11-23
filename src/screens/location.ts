import { AppLocationAccuracy, type AppLocation } from '@evenrealities/even_hub_sdk'
import { getBridge, withTimeout } from '../core/bridge'
import { BODY, clock, standardPage } from '../core/ui'
import type { Screen, ScreenContext } from './types'

function distanceM(a: AppLocation, b: AppLocation): number {
  const R = 6371000
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.latitude - a.latitude)
  const dLon = rad(b.longitude - a.longitude)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export function createLocationScreen(ctx: ScreenContext): Screen {
  let last: AppLocation | null = null
  let prev: AppLocation | null = null
  let updating = false
  let updates = 0
  let travelled = 0
  let message = 'タップで現在地を1回取得'
  let unsubscribe: (() => void) | undefined

  const content = () => {
    const l = last
    return [
      l ? `緯度 ${l.latitude.toFixed(6)}  経度 ${l.longitude.toFixed(6)}` : '緯度 —  経度 —',
      `精度 ${l?.accuracy !== undefined ? `±${l.accuracy.toFixed(0)}m` : '—'}  高度 ${l?.altitude !== undefined ? `${l.altitude.toFixed(0)}m` : '—'}  速度 ${l?.speed !== undefined ? `${l.speed.toFixed(1)}m/s` : '—'}`,
      `取得時刻 ${l?.timestamp ? clock(l.timestamp) : '—'}`,
      `連続更新 ${updating ? '● ON' : 'OFF'}  受信 ${updates}回  移動 ${travelled.toFixed(0)}m`,
      message,
    ].join('\n')
  }
  const paint = () => ctx.setText(BODY.id, BODY.name, content())

  const accept = (l: AppLocation) => {
    prev = last
    last = l
    if (prev) travelled += distanceM(prev, l)
  }

  const once = async () => {
    message = '取得中…（スマホのGPS）'
    paint()
    try {
      const l = await withTimeout('getAppLocation', getBridge().getAppLocation({ accuracy: AppLocationAccuracy.High, timeoutMs: 10000 }), 12000)
      if (l) {
        accept(l)
        message = '1回取得しました'
      } else {
        message = '取得できませんでした（権限なし/測位できず）'
      }
    } catch (e) {
      message = `エラー: ${String(e).slice(0, 60)}`
    }
    ctx.log(`位置(1回): ${message}`)
    paint()
  }

  const startUpdates = async () => {
    try {
      const ok = await getBridge().startAppLocationUpdates({ accuracy: AppLocationAccuracy.High, intervalMs: 2000, distanceFilter: 0 })
      updating = ok
      message = ok ? '連続更新を開始（2秒ごと）' : '連続更新を開始できませんでした'
    } catch (e) {
      message = `エラー: ${String(e).slice(0, 60)}`
    }
    paint()
  }

  const stopUpdates = async () => {
    try {
      await getBridge().stopAppLocationUpdates()
    } catch (e) {
      ctx.log(`位置の停止でエラー: ${String(e)}`)
    }
    updating = false
    message = '連続更新を停止'
    paint()
  }

  const render = async () => {
    await ctx.render(standardPage('位置情報', content(), 'タップ 1回取得  ↑ 連続開始  ↓ 停止  長押し 戻る'))
  }

  return {
    title: '位置情報',
    description: 'スマホのGPSで現在地を1回取得 / 連続更新と移動距離',
    actions: [
      { id: 10, label: '現在地を取得', run: once },
      { id: 11, label: '連続更新 開始', run: startUpdates },
      { id: 12, label: '連続更新 停止', run: stopUpdates },
    ],
    enter: async () => {
      unsubscribe = getBridge().onAppLocationChanged(l => {
        updates++
        accept(l)
        paint()
      })
      await render()
    },
    render,
    onInput(input) {
      if (input.kind !== 'gesture') return
      if (input.gesture === 'tap') void once()
      if (input.gesture === 'up') void startUpdates()
      if (input.gesture === 'down') void stopUpdates()
    },
    leave: async () => {
      if (updating) await stopUpdates()
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}
