// Развёртка скина Minecraft: кубоид W×H×D текселей с началом (u, v) в раскладке 64×64 (64×32 совпадает по верхней половине).
export type Face = { w: number; h: number; u: number; v: number; rot: string; out: number }
export type Part = {
  x: number
  y: number
  u: number
  v: number
  W: number
  H: number
  D: number
  over?: [number, number]
  grow?: number
  mirror?: boolean
  swing?: 1 | -1
}

export function faces(u: number, v: number, W: number, H: number, D: number): Face[] {
  return [
    { w: W, h: H, u: u + D, v: v + D, rot: '', out: D / 2 },
    { w: W, h: H, u: u + 2 * D + W, v: v + D, rot: 'rotateY(180deg)', out: D / 2 },
    { w: D, h: H, u, v: v + D, rot: 'rotateY(-90deg)', out: W / 2 },
    { w: D, h: H, u: u + D + W, v: v + D, rot: 'rotateY(90deg)', out: W / 2 },
    { w: W, h: D, u: u + D, v, rot: 'rotateX(90deg)', out: H / 2 },
    { w: W, h: D, u: u + D + W, v, rot: 'rotateX(-90deg)', out: H / 2 },
  ]
}

// Позиции — левый верхний угол передней грани в текселях; фигура 16×32. Старые скины 64×32 зеркалят правые конечности и не имеют второго слоя.
export function parts(slim: boolean, legacy: boolean): Part[] {
  const A = slim ? 3 : 4
  const over = (u: number, v: number): [number, number] | undefined => (legacy ? undefined : [u, v])
  return [
    { x: 4, y: 0, u: 0, v: 0, W: 8, H: 8, D: 8, over: [32, 0], grow: 1 },
    { x: 4, y: 8, u: 16, v: 16, W: 8, H: 12, D: 4, over: over(16, 32) },
    { x: 4 - A, y: 8, u: 40, v: 16, W: A, H: 12, D: 4, over: over(40, 32), swing: 1 },
    legacy
      ? { x: 12, y: 8, u: 40, v: 16, W: A, H: 12, D: 4, mirror: true, swing: -1 }
      : { x: 12, y: 8, u: 32, v: 48, W: A, H: 12, D: 4, over: [48, 48], swing: -1 },
    { x: 4, y: 20, u: 0, v: 16, W: 4, H: 12, D: 4, over: over(0, 32), swing: -1 },
    legacy
      ? { x: 8, y: 20, u: 0, v: 16, W: 4, H: 12, D: 4, mirror: true, swing: 1 }
      : { x: 8, y: 20, u: 16, v: 48, W: 4, H: 12, D: 4, over: [0, 48], swing: 1 },
  ]
}
