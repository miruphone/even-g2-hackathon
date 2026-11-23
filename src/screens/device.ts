import type { DeviceInfo, UserInfo } from '@evenrealities/even_hub_sdk'
import { enqueue, getBridge } from '../core/bridge'
import { BODY, clock, standardPage, yesNo } from '../core/ui'
import type { Screen, ScreenContext } from './types'

export function createDeviceScreen(ctx: ScreenContext): Screen {
  let device: DeviceInfo | null = null
  let user: UserInfo | null = null
  let fetchedAt = 0
  let error = ''
  let timer: ReturnType<typeof setInterval> | undefined

  const content = () => {
    const s = ctx.state.deviceStatus ?? device?.status
    return [
      `メガネ ${device?.model?.toUpperCase() ?? '—'}  SN ${device?.sn ?? '—'}`,
      `接続 ${s?.connectType ?? '—'}  電池 ${s?.batteryLevel ?? '—'}%  充電中 ${yesNo(s?.isCharging)}`,
      `装着中 ${yesNo(s?.isWearing)}  ケース内 ${yesNo(s?.isInCase)}  状態通知 ${ctx.state.deviceStatusUpdates}回`,
      `ユーザー ${user?.name || '—'} (uid ${user?.uid ?? '—'}, ${user?.country || '—'})`,
      `起動元 ${ctx.state.launchSource ?? '—'}  取得 ${fetchedAt ? clock(fetchedAt) : '—'}`,
      error ? `エラー: ${error}` : '装着・電池の変化は自動で反映',
    ].join('\n')
  }
  const paint = () => ctx.setText(BODY.id, BODY.name, content())

  const refresh = async () => {
    error = ''
    try {
      device = await enqueue('getDeviceInfo', () => getBridge().getDeviceInfo())
      user = await enqueue('getUserInfo', () => getBridge().getUserInfo())
      fetchedAt = Date.now()
    } catch (e) {
      error = String(e).slice(0, 80)
    }
    paint()
  }

  const render = async () => {
    await ctx.render(standardPage('端末・ユーザー情報', content(), 'タップ 再取得  長押し 戻る'))
  }

  return {
    title: '端末情報',
    description: 'メガネの機種・電池・装着状態、ユーザー情報、起動元',
    actions: [{ id: 10, label: '再取得', run: refresh }],
    enter: async () => {
      await render()
      await refresh()
      // Status pushes update ctx.state; repaint while the screen is open.
      let seen = ctx.state.deviceStatusUpdates
      timer = setInterval(() => {
        if (ctx.state.deviceStatusUpdates !== seen) {
          seen = ctx.state.deviceStatusUpdates
          paint()
        }
      }, 500)
    },
    render,
    onInput(input) {
      if (input.kind === 'gesture' && input.gesture === 'tap') void refresh()
    },
    leave: async () => {
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}
