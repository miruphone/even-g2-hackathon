// Canvas helpers for glasses images.
//
// The host converts whatever it receives to 4-bit greyscale, and accepts PNG
// file bytes as number[]. Black is "off" on the micro-LED, so every image is
// drawn on a black background, and photos are pre-converted to 16 grey levels
// (BT.601 luminance) so the preview on the phone matches the glasses.

export function makeCanvas(w: number, h: number) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')
  if (!g) throw new Error('2D canvas is not available')
  g.fillStyle = '#000'
  g.fillRect(0, 0, w, h)
  return { canvas, g }
}

export async function canvasToPng(canvas: HTMLCanvasElement): Promise<number[]> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/png'),
  )
  return Array.from(new Uint8Array(await blob.arrayBuffer()))
}

export function toGrey16(g: CanvasRenderingContext2D, w: number, h: number) {
  const img = g.getImageData(0, 0, w, h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    const q = Math.round(l / 17) * 17 // 16 levels: 0, 17, ..., 255
    d[i] = d[i + 1] = d[i + 2] = q
    d[i + 3] = 255
  }
  g.putImageData(img, 0, 0)
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('画像を読み込めませんでした'))
    img.src = src
  })
}

/** Fit the whole image inside w×h (letterboxed on black). */
export function drawContain(g: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number) {
  const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight)
  const dw = img.naturalWidth * scale
  const dh = img.naturalHeight * scale
  g.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
}
