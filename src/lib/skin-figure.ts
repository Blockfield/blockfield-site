/** Сборка 3D-фигуры скина из CSS-кубоидов. Только для браузера: трогает DOM. */
import { faces, parts } from './skin3d.ts'

export type FigureSkin = { skinUrl: string | null; capeUrl?: string | null; slim: boolean }

const px = (n: number) => `calc(${n} * var(--s))`

function box(
  x: number,
  y: number,
  u: number,
  v: number,
  W: number,
  H: number,
  D: number,
  style = '',
): HTMLElement {
  const el = document.createElement('div')
  el.className = 'box'
  el.style.cssText = `left:${px(x)};top:${px(y)};width:${px(W)};height:${px(H)};${style}`
  for (const f of faces(u, v, W, H, D)) {
    const face = document.createElement('span')
    face.className = 'face'
    face.style.cssText = `width:${px(f.w)};height:${px(f.h)};background-position:${px(-f.u)} ${px(-f.v)};transform:${f.rot} translateZ(${px(f.out)})`
    el.append(face)
  }
  return el
}

function build(figure: HTMLElement, skin: FigureSkin, legacy: boolean) {
  figure.replaceChildren()
  figure.classList.toggle('blank', !skin.skinUrl)
  figure.style.setProperty('--tex', skin.skinUrl ? `url("${skin.skinUrl}")` : 'none')
  for (const p of parts(skin.slim, legacy)) {
    const el = box(p.x, p.y, p.u, p.v, p.W, p.H, p.D, p.mirror ? 'transform:scaleX(-1)' : '')
    if (p.swing) el.className += ` swing${p.swing < 0 ? ' back' : ''}`
    if (p.over) {
      const g = p.grow ?? 0.5
      const overlay = box(
        0,
        0,
        p.over[0],
        p.over[1],
        p.W,
        p.H,
        p.D,
        `transform:scale3d(${(p.W + g) / p.W},${(p.H + g) / p.H},${(p.D + g) / p.D})`,
      )
      overlay.classList.add('overlay')
      el.append(overlay)
    }
    figure.append(el)
  }
  if (skin.capeUrl)
    figure.append(
      box(
        3,
        8,
        0,
        0,
        10,
        16,
        1,
        `--tex:url("${skin.capeUrl}");transform:translateZ(${px(-2.5)}) rotateY(180deg) rotateX(8deg)`,
      ),
    )
}

/** Рисует фигуру и (один раз на сцену) включает вращение перетаскиванием. */
export function drawFigure(stage: HTMLElement, figure: HTMLElement, skin: FigureSkin) {
  if (!stage.dataset.dragging) {
    stage.dataset.dragging = '1'
    let yaw = 0,
      from: number | null = null
    stage.addEventListener('pointerdown', (e) => {
      from = e.clientX
      stage.classList.add('grabbed')
      stage.setPointerCapture(e.pointerId)
    })
    stage.addEventListener('pointermove', (e) => {
      if (from === null) return
      yaw += (e.clientX - from) * 0.6
      from = e.clientX
      figure.style.setProperty('--yaw', `${yaw}deg`)
    })
    const release = () => {
      from = null
      stage.classList.remove('grabbed')
    }
    stage.addEventListener('pointerup', release)
    stage.addEventListener('pointercancel', release)
  }
  // Старые скины 64×32 зеркалят правые конечности и не имеют второго слоя — различаем их по высоте файла.
  const fallback = () => build(figure, { ...skin, skinUrl: '/skins/steve.png', slim: false }, false)
  if (!skin.skinUrl) return fallback()
  const image = new Image()
  image.onload = () => build(figure, skin, image.height === 32)
  image.onerror = fallback
  image.src = skin.skinUrl
}
